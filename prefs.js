import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {parseColor} from './color.js';
import {OWN_MOTION, REBOUND_CURVES} from './geometry.js';
import {gnomeSearches} from './query.js';
import {BarPreview} from './preview.js';
import {isUsableShortcut} from './shortcut.js';

const DEFAULT_HIGHLIGHT = '#3584e4';
// Settings the "Reset Position and Size" button puts back.
const GEOMETRY_KEYS = ['position', 'custom-x', 'custom-y', 'width', 'visible-rows'];

function rgbaToHex(rgba) {
    return `#${[rgba.red, rgba.green, rgba.blue]
        .map(c => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * GNOME's search providers installed on this system, as the overview finds
 * them: one .ini file per provider in gnome-shell/search-providers of each
 * data directory, the user's first.
 *
 * @returns {{id: string, name: string, icon: ?Gio.Icon, defaultEnabled: boolean}[]}
 *   by name
 */
function installedProviders() {
    const found = new Map();
    for (const dataDir of [GLib.get_user_data_dir(), ...GLib.get_system_data_dirs()]) {
        const dir = Gio.File.new_for_path(GLib.build_filenamev([dataDir, 'gnome-shell', 'search-providers']));
        let children;
        try {
            children = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        } catch {
            continue;
        }
        for (const info of children) {
            const keyfile = new GLib.KeyFile();
            try {
                keyfile.load_from_file(dir.get_child(info.get_name()).get_path(), GLib.KeyFileFlags.NONE);
                const id = keyfile.get_string('Shell Search Provider', 'DesktopId');
                const app = GioUnix.DesktopAppInfo.new(id);
                // GNOME ignores providers of hidden apps altogether.
                if (!app?.should_show() || found.has(id))
                    continue;
                let defaultEnabled = true;
                try {
                    defaultEnabled = !keyfile.get_boolean('Shell Search Provider', 'DefaultDisabled');
                } catch {
                    // Not set: on unless turned off.
                }
                found.set(id, {id, name: app.get_name(), icon: app.get_icon(), defaultEnabled});
            } catch {
                // Not a search provider, or its app is not installed.
            }
        }
    }
    return [...found.values()].sort((a, b) => GLib.utf8_collate(a.name, b.name));
}

export default class SearchBarPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        // Keeps the settings alive as long as the window.
        window._settings = settings;
        window.set_default_size(780, 760);

        const spin = (group, key, title, min, max, step, subtitle = null) => {
            const row = Adw.SpinRow.new_with_range(min, max, step);
            row.title = title;
            row.subtitle = subtitle;
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
            group.add(row);
            return row;
        };
        const toggle = (group, key, title, subtitle = null) => {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            group.add(row);
            return row;
        };
        // A row with a slider for an integer key. `mark` puts a tick under
        // a value, such as the default.
        const slider = (group, key, title, min, max, subtitle = null, mark = null) => {
            const row = new Adw.ActionRow({title, subtitle});
            const scale = new Gtk.Scale({
                adjustment: new Gtk.Adjustment({lower: min, upper: max, step_increment: 1, page_increment: 10}),
                digits: 0,
                draw_value: true,
                value_pos: Gtk.PositionType.RIGHT,
                width_request: 220,
                valign: Gtk.Align.CENTER,
            });
            if (mark !== null)
                scale.add_mark(mark, Gtk.PositionType.BOTTOM, null);
            const sync = () => {
                if (Math.round(scale.get_value()) !== settings.get_int(key))
                    scale.set_value(settings.get_int(key));
            };
            settings.connect(`changed::${key}`, sync);
            sync();
            scale.connect('value-changed', () => {
                const value = Math.round(scale.get_value());
                if (value !== settings.get_int(key))
                    settings.set_int(key, value);
            });
            row.add_suffix(scale);
            group.add(row);
            return row;
        };
        // ComboRow for a string key with <choices>; options is [[value, label], ...].
        const choice = (group, key, title, options, subtitle = null) => {
            const row = new Adw.ComboRow({
                title,
                subtitle,
                model: Gtk.StringList.new(options.map(([, label]) => label)),
            });
            const values = options.map(([value]) => value);
            const sync = () => {
                row.selected = Math.max(values.indexOf(settings.get_string(key)), 0);
            };
            settings.connect(`changed::${key}`, sync);
            sync();
            row.connect('notify::selected', () => {
                if (settings.get_string(key) !== values[row.selected])
                    settings.set_string(key, values[row.selected]);
            });
            group.add(row);
            return row;
        };
        // A switch to use a custom color instead of the accent color, and
        // the color button, for a string key holding #rrggbb or ''.
        const color = (group, key, title, subtitle) => {
            const row = new Adw.ActionRow({title, subtitle});
            const button = new Gtk.ColorDialogButton({
                dialog: new Gtk.ColorDialog({with_alpha: false}),
                valign: Gtk.Align.CENTER,
            });
            const toggleColor = new Gtk.Switch({valign: Gtk.Align.CENTER});
            row.add_suffix(button);
            row.add_suffix(toggleColor);
            row.activatable_widget = toggleColor;
            // Writing the setting fires changed::, which would sync the
            // widgets being written from; the flag breaks that loop.
            let syncing = false;
            const sync = () => {
                syncing = true;
                const value = parseColor(settings.get_string(key));
                const rgba = new Gdk.RGBA();
                rgba.parse(value ?? DEFAULT_HIGHLIGHT);
                button.rgba = rgba;
                button.sensitive = value !== null;
                toggleColor.active = value !== null;
                syncing = false;
            };
            settings.connect(`changed::${key}`, sync);
            sync();
            const save = () => {
                if (!syncing)
                    settings.set_string(key, toggleColor.active ? rgbaToHex(button.rgba) : '');
            };
            toggleColor.connect('notify::active', save);
            button.connect('notify::rgba', save);
            group.add(row);
            return row;
        };
        // A shortcut for an `as` key: shows the current one, and a button
        // that waits for the next key combination. Escape cancels, and a
        // button turns the shortcut off (a key for that would be one more
        // key that cannot be the shortcut).
        const shortcut = (group, key, title, subtitle = null) => {
            const row = new Adw.ActionRow({title, subtitle});
            const label = new Gtk.ShortcutLabel({
                disabled_text: _('Disabled'),
                valign: Gtk.Align.CENTER,
            });
            const sync = () => {
                label.accelerator = settings.get_strv(key)[0] ?? '';
            };
            settings.connect(`changed::${key}`, sync);
            sync();
            const button = new Gtk.Button({label: _('Change'), valign: Gtk.Align.CENTER});
            button.connect('clicked', () => {
                const body = _('Press the keys to use, with Ctrl, Alt or Super. Escape cancels.');
                const dialog = new Adw.AlertDialog({
                    heading: _('New shortcut'),
                    body,
                    close_response: 'cancel',
                });
                dialog.add_response('cancel', _('Cancel'));
                dialog.add_response('disable', _('Disable'));
                dialog.set_response_appearance('disable', Adw.ResponseAppearance.DESTRUCTIVE);
                dialog.connect('response', (_d, response) => {
                    if (response === 'disable')
                        settings.set_strv(key, []);
                });
                // Sees the keys before the dialog's buttons do.
                const controller = new Gtk.EventControllerKey({propagation_phase: Gtk.PropagationPhase.CAPTURE});
                controller.connect('key-pressed', (_c, keyval, keycode, state) => {
                    const mods = state & Gtk.accelerator_get_default_mod_mask();
                    if (keyval === Gdk.KEY_Escape && !mods) {
                        dialog.close();
                        return Gdk.EVENT_STOP;
                    }
                    // Tab and Enter still reach the buttons, so Disable and
                    // Cancel work from the keyboard.
                    const navigation = [Gdk.KEY_Tab, Gdk.KEY_ISO_Left_Tab, Gdk.KEY_Return, Gdk.KEY_KP_Enter,
                        Gdk.KEY_space];
                    if (!mods && navigation.includes(keyval))
                        return Gdk.EVENT_PROPAGATE;
                    // Wait for a key that is not only a modifier.
                    if (!Gtk.accelerator_valid(keyval, mods))
                        return Gdk.EVENT_STOP;
                    const accelerator = Gtk.accelerator_name_with_keycode(null, keyval, keycode, mods);
                    if (!isUsableShortcut(accelerator)) {
                        // Plain text: the key's name is not markup.
                        dialog.body = _('%s cannot be the shortcut alone: every app would lose that key. ' +
                            'Add Ctrl, Alt or Super; only keys such as F1 to F12 or Print work alone.')
                            .replace('%s', Gtk.accelerator_get_label(keyval, mods));
                        return Gdk.EVENT_STOP;
                    }
                    settings.set_strv(key, [accelerator]);
                    dialog.close();
                    return Gdk.EVENT_STOP;
                });
                dialog.add_controller(controller);
                dialog.present(window);
            });
            row.add_suffix(label);
            row.add_suffix(button);
            group.add(row);
            return row;
        };
        const page = (name, title, icon) => {
            const p = new Adw.PreferencesPage({name, title, icon_name: icon});
            window.add(p);
            return p;
        };
        const group = (parent, title, description = null) => {
            const g = new Adw.PreferencesGroup({title, description});
            parent.add(g);
            return g;
        };
        const preview = parent => {
            const g = new Adw.PreferencesGroup();
            g.add(new BarPreview(settings));
            parent.add(g);
        };
        const curves = [
            ['smooth', _('Smooth')],
            ['overshoot', _('Overshoot')],
            ['bounce', _('Bounce')],
            ['elastic', _('Elastic')],
            ['linear', _('Linear')],
        ];

        // Appearance
        const appearance = page('appearance', _('Appearance'), 'applications-graphics-symbolic');
        preview(appearance);
        const sizeGroup = group(appearance, _('Size'),
            _('Width and rows also change by dragging the grip at the bar\'s bottom-right corner.'));
        spin(sizeGroup, 'width', _('Width (px)'), 320, 1600, 20);
        spin(sizeGroup, 'visible-rows', _('Rows shown'), 1, 20, 1, _('More results scroll'));
        spin(sizeGroup, 'icon-size', _('Icon size (px)'), 16, 64, 2);
        spin(sizeGroup, 'font-size', _('Text size (px)'), 0, 32, 1, _('0 uses the theme\'s size'));
        toggle(sizeGroup, 'show-descriptions', _('Show descriptions'),
            _('A second line: a file\'s folder, an open window\'s app'));
        toggle(sizeGroup, 'show-source', _('Show where results come from'));

        const highlightGroup = group(appearance, _('Highlight'));
        color(highlightGroup, 'highlight-color', _('Custom color'),
            _('Use this color instead of the system accent color'));
        slider(highlightGroup, 'highlight-opacity', _('Opacity (%)'), 10, 100);
        spin(highlightGroup, 'corner-radius', _('Corner radius (px)'), 0, 32, 1);
        spin(highlightGroup, 'border-width', _('Border width (px)'), 0, 6, 1, _('0 draws no border'));
        slider(highlightGroup, 'focus-scale', _('Selected icon size (%)'), 100, 130,
            _('100 turns the growth off'), 110);

        const barGroup = group(appearance, _('Bar'));
        spin(barGroup, 'panel-radius', _('Corner radius (px)'), 0, 48, 2);
        slider(barGroup, 'panel-opacity', _('Background opacity (%)'), 50, 100);
        slider(barGroup, 'backdrop-opacity', _('Darken the screen behind (%)'), 0, 80,
            _('0 leaves the screen as it is'));

        // Animation
        const animation = page('animation', _('Animation'), 'media-playback-start-symbolic');
        preview(animation);
        const openGroup = group(animation, _('Opening'),
            _('Animations follow GNOME\'s Animations setting: with animations off, they are instant.'));
        const openDescriptions = {
            zoom: _('Grows from a little smaller'),
            slide: _('Drops in from above'),
            unfold: _('Opens downwards like a menu'),
            fade: _('Fades in where it is'),
            none: _('Appears at once'),
        };
        const openRow = choice(openGroup, 'open-animation', _('Style'), [
            ['zoom', _('Zoom')],
            ['slide', _('Slide')],
            ['unfold', _('Unfold')],
            ['fade', _('Fade')],
            ['none', _('None')],
        ]);
        const openDuration = spin(openGroup, 'open-duration', _('Duration (ms)'), 50, 1000, 10,
            _('Closing takes 70% of it'));
        const openCurve = choice(openGroup, 'open-curve', _('Curve'), curves);
        const revealAmount = slider(openGroup, 'reveal-amount', _('Distance (%)'), 0, 100,
            _('How small zoom starts, how far slide comes from'), 50);

        const moveGroup = group(animation, _('Selection'));
        const moveDescriptions = {
            slide: _('Glides to the next result'),
            stretch: _('Reaches over both, then lets go'),
            liquid: _('A drop that flows down the list'),
            jelly: _('Wobbles into place'),
            pop: _('Shrinks away and pops up again'),
            fade: _('Fades out and in again'),
            none: _('Jumps at once'),
        };
        const styleRow = choice(moveGroup, 'animation', _('Style'), [
            ['slide', _('Slide')],
            ['stretch', _('Stretch')],
            ['liquid', _('Liquid')],
            ['jelly', _('Jelly')],
            ['pop', _('Pop')],
            ['fade', _('Fade')],
            ['none', _('None')],
        ]);
        const moveDuration = spin(moveGroup, 'animation-duration', _('Duration (ms)'), 50, 1000, 10);
        const curveRow = choice(moveGroup, 'animation-curve', _('Curve'), curves);
        const reboundRow = slider(moveGroup, 'curve-rebound', _('Rebound (%)'), 0, 100,
            _('How far overshoot, bounce and elastic go'), 50);

        const tuneGroup = group(animation, _('Fine-tuning'));
        const tuneRows = {
            stretch: [slider(tuneGroup, 'stretch-reach', _('Reach (%)'), 20, 70,
                _('Share of the time spent reaching over both'), 40)],
            liquid: [slider(tuneGroup, 'liquid-viscosity', _('How liquid (%)'), 0, 100,
                _('More: the head runs ahead, the neck thins'), 50)],
            jelly: [
                slider(tuneGroup, 'jelly-bounce', _('Bounce (%)'), 0, 100, null, 50),
                spin(tuneGroup, 'jelly-wobbles', _('Wobbles'), 1, 4, 1),
                slider(tuneGroup, 'jelly-stretch', _('Stretch (%)'), 0, 60, _('How much it stretches while moving'), 30),
            ],
            pop: [slider(tuneGroup, 'pop-size', _('Smallest size (%)'), 0, 80,
                _('Size it shrinks to before jumping'), 30)],
        };
        const resultsGroup = group(animation, _('Results'));
        toggle(resultsGroup, 'animate-results', _('Animate the list'),
            _('The list grows and shrinks smoothly and new rows fade in'));

        const syncAnimation = () => {
            const open = settings.get_string('open-animation');
            openRow.subtitle = openDescriptions[open] ?? '';
            const opens = open !== 'none';
            const notUsed = _('Not used by this style');
            openDuration.sensitive = opens;
            openCurve.sensitive = opens;
            revealAmount.sensitive = ['zoom', 'slide', 'unfold'].includes(open);
            revealAmount.subtitle = revealAmount.sensitive
                ? _('How small zoom starts, how far slide comes from') : notUsed;

            const style = settings.get_string('animation');
            styleRow.subtitle = moveDescriptions[style] ?? '';
            moveDuration.sensitive = style !== 'none';
            curveRow.sensitive = !OWN_MOTION.includes(style);
            curveRow.subtitle = curveRow.sensitive ? '' : notUsed;
            const rebounds = (curveRow.sensitive && REBOUND_CURVES.includes(settings.get_string('animation-curve'))) ||
                (opens && REBOUND_CURVES.includes(settings.get_string('open-curve')));
            reboundRow.sensitive = rebounds;
            reboundRow.subtitle = rebounds ? _('How far overshoot, bounce and elastic go')
                : _('Used by overshoot, bounce and elastic');
            tuneGroup.visible = style in tuneRows;
            for (const [name, rows] of Object.entries(tuneRows))
                rows.forEach(r => (r.visible = name === style));
        };
        for (const key of ['open-animation', 'open-curve', 'animation', 'animation-curve'])
            settings.connect(`changed::${key}`, syncAnimation);
        syncAnimation();

        // Sources
        const sources = page('sources', _('Sources'), 'system-search-symbolic');
        const builtinGroup = group(sources, _('Built in'));
        const disabled = () => settings.get_strv('disabled-sources');
        const sourceRow = (parent, id, title, subtitle, icon) => {
            // Providers' names come from their .desktop files: plain text,
            // never markup ("Notes & Tasks" is not even valid markup).
            const row = new Adw.SwitchRow({title, subtitle, use_markup: false});
            if (icon) {
                row.add_prefix(icon instanceof Gio.Icon
                    ? Gtk.Image.new_from_gicon(icon) : Gtk.Image.new_from_icon_name(icon));
            }
            const sync = () => {
                const active = !disabled().includes(id);
                if (row.active !== active)
                    row.active = active;
            };
            settings.connect('changed::disabled-sources', sync);
            sync();
            row.connect('notify::active', () => {
                const others = disabled().filter(s => s !== id);
                const next = row.active ? others : [...others, id];
                if (next.length !== disabled().length)
                    settings.set_strv('disabled-sources', next);
            });
            parent.add(row);
            return row;
        };
        sourceRow(builtinGroup, 'applications', _('Applications'), _('Installed apps'), 'view-app-grid-symbolic');
        sourceRow(builtinGroup, 'windows', _('Open windows'), _('Find a window by its title or app'),
            'focus-windows-symbolic');
        sourceRow(builtinGroup, 'actions', _('System actions'), _('Lock, log out, power off…'),
            'system-shutdown-symbolic');
        const providerGroup = group(sources, _('GNOME search providers'),
            _('The bar searches with the providers GNOME uses: those turned off in Settings › Search find ' +
                'nothing here either.'));
        // GNOME's own choice, read as the overview reads it, so a provider it
        // leaves out does not look on here.
        const searchSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.search-providers'});
        window._searchSettings = searchSettings;
        const providers = installedProviders();
        const providerRows = providers.map(provider => {
            const row = sourceRow(providerGroup, provider.id, provider.name, null, provider.icon);
            return {provider, row};
        });
        const syncGnome = () => {
            const gnome = {
                disableExternal: searchSettings.get_boolean('disable-external'),
                enabled: searchSettings.get_strv('enabled'),
                disabled: searchSettings.get_strv('disabled'),
            };
            for (const {provider, row} of providerRows) {
                const on = gnomeSearches(provider.id, provider.defaultEnabled, gnome);
                row.sensitive = on;
                row.subtitle = on ? '' : _('Turned off in Settings › Search');
            }
        };
        searchSettings.connect('changed', syncGnome);
        syncGnome();
        if (providers.length === 0)
            providerGroup.add(new Adw.ActionRow({title: _('No search providers are installed')}));
        // Opens GNOME's own page, without a shell: a fixed argv.
        const openSearch = new Adw.ButtonRow({
            title: _('Open Search Settings'),
            end_icon_name: 'adw-external-link-symbolic',
        });
        openSearch.sensitive = GLib.find_program_in_path('gnome-control-center') !== null;
        openSearch.connect('activated', () => {
            try {
                Gio.Subprocess.new(['gnome-control-center', 'search'], Gio.SubprocessFlags.NONE);
            } catch (e) {
                console.error(`[search-bar] gnome-control-center: ${e}`);
            }
        });
        providerGroup.add(openSearch);

        // Behavior
        const behavior = page('behavior', _('Behavior'), 'preferences-system-symbolic');
        const openingGroup = group(behavior, _('Opening'));
        shortcut(openingGroup, 'search-bar-toggle', _('Shortcut'), _('Opens and closes the bar'));
        choice(openingGroup, 'monitor', _('Monitor'), [
            ['pointer', _('Under the pointer')],
            ['focused', _('Of the focused window')],
            ['primary', _('Primary')],
        ]);
        toggle(openingGroup, 'close-on-click-outside', _('Close when clicking outside'));

        const placeGroup = group(behavior, _('Position'),
            _('Drag the bar by its edge or its magnifier to move it.'));
        const positionRow = choice(placeGroup, 'position', _('Position'), [
            ['center', _('Center')],
            ['top', _('Top')],
            ['bottom', _('Bottom')],
            ['custom', _('Custom')],
        ]);
        const customX = new Adw.SpinRow({
            title: _('Across (%)'),
            subtitle: _('0 is the left edge, 100 the right'),
            digits: 1,
            adjustment: new Gtk.Adjustment({lower: 0, upper: 100, step_increment: 1, page_increment: 10}),
        });
        settings.bind('custom-x', customX, 'value', Gio.SettingsBindFlags.DEFAULT);
        placeGroup.add(customX);
        const customY = new Adw.SpinRow({
            title: _('Down (%)'),
            subtitle: _('0 is the top, 100 the bottom'),
            digits: 1,
            adjustment: new Gtk.Adjustment({lower: 0, upper: 100, step_increment: 1, page_increment: 10}),
        });
        settings.bind('custom-y', customY, 'value', Gio.SettingsBindFlags.DEFAULT);
        placeGroup.add(customY);
        toggle(placeGroup, 'remember-geometry', _('Save position and size'),
            _('Off: moving and resizing last until the bar closes'));
        const resetPlace = new Adw.ButtonRow({title: _('Reset Position and Size')});
        resetPlace.connect('activated', () => GEOMETRY_KEYS.forEach(key => settings.reset(key)));
        placeGroup.add(resetPlace);
        const syncPosition = () => {
            const custom = settings.get_string('position') === 'custom';
            customX.sensitive = customY.sensitive = custom;
            positionRow.subtitle = custom ? _('Set by dragging, or below') : '';
        };
        settings.connect('changed::position', syncPosition);
        syncPosition();

        const searchGroup = group(behavior, _('Search'));
        choice(searchGroup, 'empty-query', _('Before typing'), [
            ['frequent', _('Show frequent apps')],
            ['nothing', _('Show nothing')],
        ]);
        spin(searchGroup, 'results-per-source', _('Results per source'), 1, 20, 1);
        spin(searchGroup, 'max-results', _('Results in all'), 5, 100, 5);
        spin(searchGroup, 'search-delay', _('Delay (ms)'), 0, 500, 10,
            _('Wait after the last key; 0 searches on every key'));
        toggle(searchGroup, 'select-on-hover', _('Select under the pointer'));

        const resetGroup = new Adw.PreferencesGroup();
        behavior.add(resetGroup);
        const resetRow = new Adw.ButtonRow({title: _('Reset All Settings')});
        resetRow.add_css_class('destructive-action');
        resetRow.connect('activated', () => {
            const dialog = new Adw.AlertDialog({
                heading: _('Reset all settings?'),
                body: _('Every option goes back to its default.'),
                default_response: 'cancel',
                close_response: 'cancel',
            });
            dialog.add_response('cancel', _('Cancel'));
            dialog.add_response('reset', _('Reset'));
            dialog.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
            dialog.connect('response', (_d, response) => {
                if (response === 'reset')
                    settings.settings_schema.list_keys().forEach(key => settings.reset(key));
            });
            dialog.present(window);
        });
        resetGroup.add(resetRow);

        // Lets tests/smoke.sh screenshot every page.
        const first = GLib.getenv('SEARCH_BAR_PREFS_PAGE');
        if (first)
            window.visible_page_name = first;
    }
}
