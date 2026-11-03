import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as ParentalControlsManager from 'resource:///org/gnome/shell/misc/parentalControlsManager.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';

import {isSubSearch, labelText, mergeResults, rankWindows, sameResults, sameTerms, sourceEnabled, termsFor} from './query.js';

// The overview's own provider of apps (and system actions such as Power Off).
const APPS_PROVIDER = 'applications';

/**
 * GNOME's search providers, as the overview loaded them: they already
 * follow Settings › Search (sources turned off, their order) and parental
 * controls, and reusing them starts no D-Bus proxies of our own.
 *
 * @returns {object[]} the providers, in the overview's order
 */
function overviewProviders() {
    // Private fields of the overview (ui/overview.js, overviewControls.js)
    // and of SearchResultsView (ui/search.js), as in GNOME 50.
    return Main.overview._overview?.controls?._searchController?._searchResults?._providers ?? [];
}

/**
 * Searches every enabled source as the text changes, and reports the
 * merged results each time a source answers. Created when the bar opens,
 * destroyed when it closes.
 */
export class Searcher {
    /**
     * @param {object} config options read when the bar opened
     * @param {Function} onResults called with (results, searching, info):
     *   `searching` while sources are still answering; info.terms are the
     *   terms the results are for, and info.ready says the apps and system
     *   actions (the fast, local source) have answered
     */
    constructor(config, onResults) {
        this._config = config;
        this._onResults = onResults;
        this._cancellable = new Gio.Cancellable();
        this._timeoutId = 0;
        // Terms of the search waiting for the delay to pass.
        this._pendingTerms = null;
        this._generation = 0;
        this._terms = [];
        // Ids each provider returned last time, for narrowing the search.
        this._previous = {};
        this._windows = new Map();
    }

    get terms() {
        return this._terms;
    }

    /** @returns {boolean} a search is waiting for the delay to pass */
    get pending() {
        return this._timeoutId !== 0;
    }

    /**
     * Searches for the text after the configured delay; the first search,
     * for an empty text, runs at once.
     *
     * @param {string} text the search field's text
     */
    setText(text) {
        const terms = termsFor(text);
        // Cleared before comparing: going back to the text of the last
        // search must also drop the one waiting for the text in between.
        this._clearTimeout();
        if (sameTerms(terms, this._terms) && this._generation > 0)
            return;
        if (terms.length === 0 || this._config.delay === 0) {
            this._search(terms);
            return;
        }
        this._pendingTerms = terms;
        this._timeoutId = GLib.timeout_add_once(GLib.PRIORITY_DEFAULT, this._config.delay, () => {
            this._timeoutId = 0;
            this._pendingTerms = null;
            this._search(terms);
        });
    }

    /**
     * Runs the search waiting for the delay now, as GNOME's overview does
     * when Enter is pressed (SearchResultsView.activateDefault()).
     */
    flush() {
        if (!this._timeoutId)
            return;
        const terms = this._pendingTerms;
        this._clearTimeout();
        this._search(terms);
    }

    _search(terms) {
        // Stop the providers still answering the previous search.
        this._cancellable.cancel();
        this._cancellable = new Gio.Cancellable();
        const cancellable = this._cancellable;
        const generation = ++this._generation;
        const subSearch = isSubSearch(this._terms, terms);
        this._terms = terms;

        if (terms.length === 0) {
            this._previous = {};
            const items = this._config.emptyQuery === 'frequent' ? this._frequentApps() : [];
            this._onResults(items, false, {terms, ready: true});
            return;
        }

        const providers = overviewProviders().filter(p => this._wanted(p));
        // Every source has a slot in order, so results always come out in
        // the same order whichever answers first.
        const groups = [
            {source: 'applications', items: []},
            {source: 'windows', items: []},
            {source: 'actions', items: []},
            ...providers.filter(p => p.id !== APPS_PROVIDER).map(p => ({source: p.id, items: []})),
        ];
        const group = source => groups.find(g => g.source === source);
        let pending = providers.length;
        // Without the apps provider there is nothing local to wait for.
        let ready = !providers.some(p => p.id === APPS_PROVIDER);
        const previous = this._previous;
        this._previous = {};
        // Each report redraws the list; most providers find nothing, so
        // only a change is reported, besides the first report (new terms),
        // the local sources coming in and the last answer (which ends
        // "Searching…").
        let changed = true;
        let reportedReady = null;
        const setItems = (source, items) => {
            const g = group(source);
            if (!sameResults(g.items, items)) {
                g.items = items;
                changed = true;
            }
        };
        const report = () => {
            if (generation !== this._generation)
                return;
            if (!changed && pending > 0 && ready === reportedReady)
                return;
            changed = false;
            reportedReady = ready;
            this._onResults(mergeResults(groups, this._config.perSource, this._config.total), pending > 0,
                {terms, ready});
        };

        if (sourceEnabled('windows', this._config.disabled))
            group('windows').items = this._windowResults(terms);
        if (pending === 0) {
            report();
            return;
        }
        for (const provider of providers) {
            this._searchProvider(provider, terms, subSearch ? previous[provider.id] : null, cancellable)
                .then(found => {
                    if (generation !== this._generation)
                        return;
                    if (provider.id === APPS_PROVIDER) {
                        setItems('applications', found.filter(r => r.kind === 'app'));
                        setItems('actions', found.filter(r => r.kind === 'action'));
                    } else {
                        setItems(provider.id, found);
                    }
                })
                .catch(e => {
                    if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.error(`[search-bar] ${provider.id}: ${e}`);
                })
                .finally(() => {
                    pending--;
                    if (provider.id === APPS_PROVIDER)
                        ready = true;
                    report();
                });
        }
    }

    _wanted(provider) {
        const disabled = this._config.disabled;
        if (provider.id === APPS_PROVIDER)
            return sourceEnabled('applications', disabled) || sourceEnabled('actions', disabled);
        return sourceEnabled(provider.id, disabled);
    }

    async _searchProvider(provider, terms, previous, cancellable) {
        const ids = previous
            ? await provider.getSubsearchResultSet(previous, terms, cancellable)
            : await provider.getInitialResultSet(terms, cancellable);
        if (cancellable.is_cancelled())
            return [];
        this._previous[provider.id] = ids;

        const perSource = this._config.perSource;
        let wanted;
        if (provider.id === APPS_PROVIDER) {
            // One provider gives both apps and system actions, which are
            // separate sources here.
            const disabled = this._config.disabled;
            const apps = sourceEnabled('applications', disabled)
                ? ids.filter(id => id.endsWith('.desktop')).slice(0, perSource) : [];
            const actions = sourceEnabled('actions', disabled)
                ? ids.filter(id => !id.endsWith('.desktop')).slice(0, perSource) : [];
            wanted = [...apps, ...actions];
        } else {
            wanted = provider.filterResults(ids, perSource);
        }
        if (wanted.length === 0)
            return [];
        const metas = await provider.getResultMetas(wanted, cancellable);
        if (cancellable.is_cancelled())
            return [];
        const sourceName = provider.id === APPS_PROVIDER ? null : provider.appInfo?.get_name() ?? provider.id;
        // Metas come from other programs over D-Bus. Like the overview
        // (search.js), drop those without an id or a name; the id must be a
        // string to be opened, and names and descriptions become bounded
        // strings whatever they were sent as.
        return metas.filter(m => m && typeof m.id === 'string' && m.id && m.name).map(meta => {
            let kind = 'remote';
            if (provider.id === APPS_PROVIDER)
                kind = meta.id.endsWith('.desktop') ? 'app' : 'action';
            return {
                id: meta.id,
                name: labelText(meta.name),
                description: labelText(meta.description),
                createIcon: size => meta.createIcon?.(size) ?? null,
                kind,
                sourceName: sourceName ?? (kind === 'app' ? _('Application') : _('System')),
                provider,
                terms,
            };
        });
    }

    _windowResults(terms) {
        const tracker = Shell.WindowTracker.get_default();
        const windows = global.display.get_tab_list(Meta.TabList.NORMAL_ALL, null)
            .filter(w => !w.skip_taskbar);
        this._windows = new Map(windows.map(w => [String(w.get_id()), w]));
        const candidates = windows.map(w => ({
            id: String(w.get_id()),
            // Titles come from other programs: bounded, and shown as plain
            // text only.
            title: labelText(w.get_title()),
            app: labelText(tracker.get_window_app(w)?.get_name()),
        }));
        return rankWindows(terms, candidates).map(id => {
            const window = this._windows.get(id);
            const app = tracker.get_window_app(window);
            const name = labelText(window.get_title());
            const appName = labelText(app?.get_name());
            return {
                id,
                name,
                // Always a second line: a window titled like its app would
                // otherwise look exactly like the app's own row above it.
                description: appName !== '' && appName !== name ? appName : _('Open window'),
                createIcon: size => app?.create_icon_texture(size) ?? null,
                kind: 'window',
                sourceName: _('Window'),
            };
        });
    }

    _frequentApps() {
        if (!sourceEnabled('applications', this._config.disabled))
            return [];
        // As the overview's app grid and search do: hidden apps and those
        // the user's parental controls deny stay hidden here too (it also
        // checks should_show()).
        const parental = ParentalControlsManager.getDefault();
        return Shell.AppUsage.get_default().get_most_used()
            .filter(app => {
                const info = app?.get_app_info();
                return info && parental.shouldShowApp(info);
            })
            .slice(0, this._config.total)
            .map(app => ({
                id: app.get_id(),
                name: labelText(app.get_name()),
                description: labelText(app.get_description()),
                createIcon: size => app.create_icon_texture(size),
                kind: 'app',
                sourceName: _('Application'),
                source: 'applications',
            }));
    }

    /**
     * Opens a result: launches or focuses an app, focuses a window, runs a
     * system action or asks its provider to open it.
     *
     * @param {object} result one of the results reported
     */
    activate(result) {
        switch (result.kind) {
        case 'app':
            Shell.AppSystem.get_default().lookup_app(result.id)?.activate();
            break;
        case 'window': {
            const window = this._windows.get(result.id);
            // The window may have closed since the search.
            if (window?.get_compositor_private())
                Main.activateWindow(window);
            break;
        }
        case 'action':
            // Power off, log out, restart...: the nested and headless test
            // shells share the machine's system bus, so only log there.
            if (GLib.getenv('SEARCH_BAR_DRY_RUN'))
                console.log(`[search-bar] dry run: would activate action ${result.id}`);
            else
                SystemActions.getDefault().activateAction(result.id);
            break;
        default:
            // The terms the result was found with, not whatever is typed now.
            result.provider.activateResult(result.id, result.terms ?? this._terms);
        }
        if (Main.overview.visible)
            Main.overview.hide();
    }

    _clearTimeout() {
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
        this._pendingTerms = null;
    }

    destroy() {
        this._clearTimeout();
        this._cancellable.cancel();
        // Stale answers check the generation and are dropped.
        this._generation++;
        this._windows.clear();
        this._onResults = () => {};
    }
}
