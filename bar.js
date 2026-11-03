import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {hexToRgb, SURFACE} from './color.js';
import {offsetShape, paintShape} from './drawing.js';
import {makeTransition, sameBox} from './geometry.js';
import {barSize, customFromPlace, ENTRY_HEIGHT, listHeight, PADDING, placeBar, resizeBy, scrollOffset} from './layout.js';
import {MAX_TEXT, moveSelection, resultKey, sameTerms, spokenLabel, termsFor} from './query.js';
import {CLOSE_SHARE, revealFrame, revealMotion} from './reveal.js';
import {Searcher} from './sources.js';

const GRIP = 20;
// How far the pointer must move, in logical pixels, before a press on the
// edge or the grip becomes a drag: a click that wobbles a pixel moves and
// saves nothing.
const DRAG_THRESHOLD = 4;
// Fade-in of a row that starts showing, and the list's change of height.
const RESULTS_DURATION = 150;
// Longest Enter waits for the results of what is typed, in milliseconds:
// GNOME's own apps provider answers well within it.
const ACTIVATE_WAIT = 500;
// How long the results must stay the same before a screen reader says
// how many there are: several sources answer one search, and saying each
// count would talk over the result being read.
const ANNOUNCE_DELAY = 500;

/**
 * The search bar: a full-screen layer that holds the bar and takes the
 * keyboard while it is open. Built when it opens and destroyed when it has
 * closed, so nothing of it exists while it is not in use.
 */
export class SearchBar {
    /**
     * @param {object} config options read from the settings on opening,
     *   see SearchBarExtension._readConfig()
     * @param {object} callbacks callbacks
     * @param {Function} callbacks.onClosed called once it has closed and
     *   destroyed itself
     * @param {Function} callbacks.onGeometry called with {x, y} (custom
     *   position, 0 to 100) or {width, rows} when the user moved or resized it
     */
    constructor(config, {onClosed, onGeometry}) {
        this._config = config;
        this._onClosed = onClosed;
        this._onGeometry = onGeometry;
        this._results = [];
        // What the results on screen were found for, and whether the apps
        // and system actions have answered yet.
        this._resultsTerms = [];
        this._ready = false;
        this._selected = -1;
        this._offset = 0;
        this._searching = false;
        // The user moved the selection in this search: new results keep it
        // on the same result instead of going back to the top.
        this._userMoved = false;
        // Enter was pressed before the results matched the text; it opens
        // the first result of the current search when it arrives.
        this._activatePending = false;
        this._activateTimeoutId = 0;
        // The count or status a screen reader will be told once the results
        // settle, and the last one told, never said twice in a row.
        this._announceTimeoutId = 0;
        this._lastAnnouncement = null;
        // Opening progress, 0 closed to 1 open (past 1 while overshooting).
        this._reveal = 0;
        this._revealTimeline = null;
        this._open = false;
        this._grab = null;
        this._drag = null;
        // The pointer has moved since the rows last changed: only then does
        // hovering select, so a row that appears under a still pointer
        // does not steal the selection.
        this._pointerMoved = false;
        this._highlightBox = null;
        this._highlightOpacity = 0;
        // The height the bar is at or easing to, see _fitHeight().
        this._heightTarget = null;
        this._timeline = null;
        this._shape = null;
        this._accent = null;
        // Icons of the results, by resultKey(), while the bar is open: a
        // row that shows a result again (scrolling back, another source
        // answering) takes its icon from here instead of building a new
        // texture. null for a result without one.
        this._icons = new Map();

        this._monitor = this._pickMonitor();
        this._scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._area = Main.layoutManager.getWorkAreaForMonitor(this._monitor);
        // The layer is on the stage from the first lines of _build(). If
        // anything after that throws (a broken icon, an API that changed),
        // take it down before passing the error on, or it would stay over
        // the whole screen.
        try {
            this._build();
            this._searcher = new Searcher(config,
                (results, searching, info) => this._setResults(results, searching, info));
            this._searcher.setText('');
        } catch (e) {
            this.destroy();
            throw e;
        }
    }

    _pickMonitor() {
        if (this._config.monitor === 'primary')
            return Main.layoutManager.primaryIndex;
        if (this._config.monitor === 'focused') {
            const focused = global.display.focus_window;
            if (focused)
                return focused.get_monitor();
        }
        return global.display.get_current_monitor();
    }

    _build() {
        const config = this._config;
        // Not reactive until open(): a layer left behind by an error must
        // not take the clicks meant for the windows and the top bar.
        this._root = new St.Widget({
            reactive: false,
            x: 0,
            y: 0,
            width: global.stage.width,
            height: global.stage.height,
        });
        // On the stage from the start, so the theme is resolved for the
        // parts that read it (the accent color of the highlight).
        Main.layoutManager.uiGroup.add_child(this._root);
        // The darkened screen, only when there is any darkening: an
        // invisible full-screen actor would still be faded in and out with
        // the bar, repainting the whole screen each frame. Clicks outside
        // reach the layer itself without it.
        this._backdrop = null;
        if (config.backdropOpacity > 0) {
            this._backdrop = new St.Widget({
                style_class: 'sb-backdrop',
                style: `background-color: rgba(0, 0, 0, ${config.backdropOpacity});`,
                x: 0,
                y: 0,
                width: global.stage.width,
                height: global.stage.height,
                opacity: 0,
            });
            this._root.add_child(this._backdrop);
        }

        // Validated values only: numbers from get_int(), colors through
        // parseColor().
        let panelStyle = `border-radius: ${config.panelRadius}px; ` +
            `background-color: rgba(${SURFACE.join(', ')}, ${config.panelOpacity});`;
        if (config.fontSize > 0)
            panelStyle += ` font-size: ${config.fontSize}px;`;
        this._panel = new St.Widget({
            style_class: 'sb-panel',
            style: panelStyle,
            reactive: true,
            clip_to_allocation: true,
            opacity: 0,
        });
        this._root.add_child(this._panel);

        this._entryBox = new St.BoxLayout({style_class: 'sb-entry-box'});
        this._handle = new St.Icon({
            icon_name: 'edit-find-symbolic',
            style_class: 'sb-search-icon',
            reactive: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._entry = new St.Entry({
            style_class: 'sb-entry',
            hint_text: _('Search…'),
            can_focus: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        // The hint goes once something is typed; screen readers keep this.
        this._entry.accessible_name = _('Search');
        // Typing or pasting stops there; see query.js MAX_TEXT.
        this._entry.clutter_text.max_length = MAX_TEXT;
        this._count = new St.Label({style_class: 'sb-count', y_align: Clutter.ActorAlign.CENTER});
        this._entryBox.add_child(this._handle);
        this._entryBox.add_child(this._entry);
        this._entryBox.add_child(this._count);
        this._panel.add_child(this._entryBox);

        this._list = new St.Widget({style_class: 'sb-list'});
        this._highlight = new St.Widget({style_class: 'sb-highlight', opacity: 0});
        // Stands in for the highlight while the liquid style runs.
        this._drop = new St.DrawingArea({visible: false});
        this._drop.connect('repaint', () => this._drawDrop());
        this._list.add_child(this._highlight);
        this._list.add_child(this._drop);
        this._status = new St.Label({style_class: 'sb-status', visible: false, y_align: Clutter.ActorAlign.CENTER});
        this._list.add_child(this._status);
        this._panel.add_child(this._list);
        this._rows = [];

        // A mark along the bar's rounded corner. St cannot paint a border
        // on two sides with a radius, so cairo draws it; it repaints only
        // when hovered or restyled, never while dragging.
        this._grip = new St.DrawingArea({style_class: 'sb-grip', reactive: true, track_hover: true});
        this._grip.connect('repaint', () => this._drawGrip());
        this._grip.connect('notify::hover', () => this._grip.queue_repaint());
        this._panel.add_child(this._grip);

        this._setCursors(null);

        this._applyHighlightStyle();
        this._textHeight = this._measureText();
        this._layout();

        const text = this._entry.clutter_text;
        text.connectObject(
            'text-changed', () => this._searcher.setText(this._entry.text),
            'key-press-event', (_actor, event) => this._onKey(event),
            'activate', () => this._activateSelected(), this);
        this._root.connectObject(
            'button-press-event', (_actor, event) => this._onBackdropPress(event),
            'captured-event', (_actor, event) => this._onCapturedEvent(event),
            'scroll-event', (_actor, event) => this._onScroll(event), this);
        this._panel.connectObject('button-press-event', (_actor, event) => this._startDrag(event, 'move'), this);
        this._handle.connectObject('button-press-event', (_actor, event) => this._startDrag(event, 'move'), this);
        this._entryBox.connectObject('button-press-event', (_actor, event) => this._startDrag(event, 'move'), this);
        this._grip.connectObject('button-press-event', (_actor, event) => this._startDrag(event, 'resize'), this);
    }

    // Places and sizes every part from the settings. Sizes come from
    // layout.js, in physical pixels, so the bar's place does not depend on
    // what the theme measures.
    // Height of a result's text, the name and the description when they
    // show, as the theme and the chosen text size draw it, in physical
    // pixels. Rows are as tall as the taller of this and the icon, so two
    // lines never spill into the next row. Measured inside the bar, where
    // its text size applies.
    _measureText() {
        const probe = new St.BoxLayout({style_class: 'sb-text', orientation: Clutter.Orientation.VERTICAL});
        probe.add_child(new St.Label({style_class: 'sb-name', text: 'Ág'}));
        if (this._config.showDescriptions)
            probe.add_child(new St.Label({style_class: 'sb-description', text: 'Ág'}));
        this._panel.add_child(probe);
        const [, height] = probe.get_preferred_height(-1);
        probe.destroy();
        return Math.ceil(height);
    }

    _layout() {
        const size = barSize({...this._config, textHeight: this._textHeight}, this._scale);
        this._size = size;
        const place = this._place ?? placeBar(this._area, size, this._config.position, this._config.custom);
        this._place = place;
        const pad = Math.round(PADDING * this._scale);
        const inner = size.width - 2 * pad;
        this._panel.set_position(place.x, place.y);
        this._panel.width = size.width;
        Object.assign(this._entryBox, {x: pad, y: pad, width: inner, height: Math.round(ENTRY_HEIGHT * this._scale)});
        Object.assign(this._list, {x: pad, y: Math.round(size.top), width: inner});
        const grip = Math.round(GRIP * this._scale);
        Object.assign(this._grip, {x: size.width - grip - 4, width: grip, height: grip});
        this._status.set_position(0, 0);
        Object.assign(this._status, {width: inner, height: size.rowHeight});

        // A row for each place in the list; their contents change as the
        // list scrolls.
        while (this._rows.length > this._config.rows) {
            const row = this._rows.pop();
            // Its icon belongs to the cache, which destroys it.
            this._takeIcon(row);
            row.destroy();
        }
        while (this._rows.length < this._config.rows)
            this._rows.push(this._makeRow(this._rows.length));
        this._rows.forEach((row, i) => {
            Object.assign(row, {x: 0, y: Math.round(i * size.rowStep), width: inner, height: size.rowHeight});
        });
        this._fitHeight(false);
    }

    _makeRow(index) {
        const row = new St.Button({
            style_class: 'sb-row',
            reactive: true,
            can_focus: false,
            track_hover: true,
            visible: false,
            x_align: Clutter.ActorAlign.FILL,
        });
        const box = new St.BoxLayout({style_class: 'sb-row-box', x_expand: true});
        const icon = new St.Bin({style_class: 'sb-icon', y_align: Clutter.ActorAlign.CENTER});
        const size = this._config.iconSize * this._scale;
        Object.assign(icon, {width: size, height: size});
        icon.set_pivot_point(0.5, 0.5);
        const text = new St.BoxLayout({
            style_class: 'sb-text',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const name = new St.Label({style_class: 'sb-name'});
        const description = new St.Label({style_class: 'sb-description', visible: this._config.showDescriptions});
        text.add_child(name);
        text.add_child(description);
        // Shown by _refresh() on the first row of each source.
        const source = new St.Label({
            style_class: 'sb-source',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        box.add_child(icon);
        box.add_child(text);
        box.add_child(source);
        row.set_child(box);
        // `key` is what the row shows (see _rowKey()), `iconKey` the
        // result whose icon it holds.
        // `spokenKey` the result last announced as selected in this row.
        row._sb = {icon, name, description, source, result: null, key: null, iconKey: null, spokenKey: null};
        row.connectObject(
            // The result the row shows, even if the list changed between
            // pressing and releasing.
            'clicked', () => this._activate(row._sb.result),
            'notify::hover', () => {
                if (row.hover && this._pointerMoved && this._config.selectOnHover && !this._drag)
                    this._select(this._offset + index);
            }, this);
        // The list is added after the highlight, so rows are in front of it.
        this._list.add_child(row);
        return row;
    }

    /** Opens the bar, from wherever it is now if it was closing. */
    open() {
        if (this._open)
            return;
        this._open = true;
        this._root.reactive = true;
        // POPUP keeps the toggle shortcut working, to close it again.
        this._grab = Main.pushModal(this._root, {actionMode: Shell.ActionMode.POPUP});
        this._entry.grab_key_focus();
        this._animateReveal(true);
    }

    /** Closes the bar with its animation, then destroys it. */
    close() {
        if (!this._open)
            return;
        this._open = false;
        this._endDrag(false);
        this._cancelPendingActivation();
        this._cancelAnnouncement();
        // Give the keyboard back now, so a dialog an activated result opens
        // (Power Off asks first) gets it while the bar fades out.
        if (this._grab)
            Main.popModal(this._grab);
        this._grab = null;
        this._root.reactive = false;
        this._animateReveal(false);
    }

    get isOpen() {
        return this._open;
    }

    _animateReveal(opening) {
        this._stopReveal();
        const config = this._config;
        const motion = revealMotion(this._reveal, opening, config.openCurve, config.motion.rebound);
        const duration = Math.round(config.openDuration * (opening ? 1 : CLOSE_SHARE));
        const done = () => {
            this._applyReveal(motion(1));
            if (!opening)
                this._finishClose();
        };
        if (config.openAnimation === 'none' || !St.Settings.get().enable_animations) {
            done();
            return;
        }
        const timeline = new Clutter.Timeline({actor: this._panel, duration});
        timeline.connect('new-frame', () => this._applyReveal(motion(timeline.get_progress())));
        timeline.connect('completed', () => {
            if (this._revealTimeline !== timeline)
                return;
            this._revealTimeline = null;
            done();
        });
        this._revealTimeline = timeline;
        this._applyReveal(motion(0));
        timeline.start();
    }

    _applyReveal(value) {
        this._reveal = value;
        const frame = revealFrame(this._config.openAnimation, value, this._config.revealAmount);
        const panel = this._panel;
        panel.set_pivot_point(0.5, frame.pivotY);
        panel.set_scale(frame.scaleX, frame.scaleY);
        panel.translation_y = Math.round(frame.dy * this._scale);
        panel.opacity = Math.round(frame.opacity * 255);
        if (this._backdrop)
            this._backdrop.opacity = Math.round(Math.min(Math.max(value, 0), 1) * 255);
    }

    _stopReveal() {
        this._revealTimeline?.stop();
        this._revealTimeline = null;
    }

    _finishClose() {
        const onClosed = this._onClosed;
        this.destroy();
        onClosed?.();
    }

    /** Takes everything down at once: used on disable and after closing. */
    destroy() {
        if (!this._root)
            return;
        // The keyboard and the pointer come back first, and the layer goes
        // whatever happens in between: an error while stopping the rest must
        // never leave the desktop grabbed or covered. It may also run on a
        // bar half built by the constructor.
        if (this._grab)
            Main.popModal(this._grab);
        this._grab = null;
        this._open = false;
        try {
            this._stopReveal();
            this._stopHighlight();
            this._endDrag(false);
            this._cancelPendingActivation();
            this._cancelAnnouncement();
            this._searcher?.destroy();
            this._entry?.clutter_text.disconnectObject(this);
            // The icons in rows go with them; the others are only here.
            for (const actor of this._icons.values())
                actor?.destroy();
            this._icons.clear();
        } finally {
            this._searcher = null;
            this._root.destroy();
            this._root = null;
            this._rows = [];
            this._results = [];
            this._onClosed = null;
            this._onGeometry = null;
        }
    }

    // --- Results ------------------------------------------------------------

    _setResults(results, searching, {terms, ready}) {
        const current = this._results[this._selected];
        // New text starts at the top, like rofi; within one search, a
        // result the user moved to stays selected as other sources answer.
        if (!sameTerms(terms, this._resultsTerms))
            this._userMoved = false;
        this._results = results;
        this._resultsTerms = terms;
        this._ready = ready;
        this._searching = searching;
        let selected = results.length > 0 ? 0 : -1;
        if (current && this._userMoved) {
            const same = results.findIndex(r => r.kind === current.kind && r.id === current.id);
            if (same >= 0)
                selected = same;
        }
        this._selected = selected;
        this._offset = scrollOffset(results.length, this._config.rows, Math.max(selected, 0), 0);
        this._pointerMoved = false;
        this._refresh(true);
        // Rows now hold only icons of these results: the others are gone.
        const keys = new Set(results.map(resultKey));
        for (const [key, actor] of this._icons) {
            if (!keys.has(key)) {
                actor?.destroy();
                this._icons.delete(key);
            }
        }
        this._resolvePendingActivation(false);
        this._scheduleAnnouncement();
    }

    _select(index) {
        if (index < 0 || index >= this._results.length || index === this._selected)
            return;
        this._userMoved = true;
        this._selected = index;
        this._offset = scrollOffset(this._results.length, this._config.rows, index, this._offset);
        this._refresh(false);
    }

    // Shows the results from the scroll offset on, and moves the highlight.
    _refresh(resultsChanged) {
        if (!this._root)
            return;
        const animate = this._config.animateResults && St.Settings.get().enable_animations;
        const visibleBefore = this._rows.filter(r => r.visible).length;
        const shown = this._rows.map((_row, i) => this._results[this._offset + i] ?? null);
        // Icons that change rows leave theirs first, so scrolling can hand
        // an icon from one row to the next.
        this._rows.forEach((row, i) => {
            if (row._sb.iconKey !== (shown[i] && resultKey(shown[i])))
                this._takeIcon(row);
        });
        this._rows.forEach((row, i) => {
            const result = shown[i];
            const wasVisible = row.visible;
            row.visible = result !== null;
            // Every report brings new objects for the same results, and the
            // list on screen rarely changes: refill only what did.
            if (result && row._sb.key !== this._rowKey(result))
                this._fillRow(row, result);
            row._sb.result = result;
            // Where results come from, once per run of the same source, and
            // on the top row, whose run may have started above the view.
            const label = result !== null && this._config.showSource &&
                (i === 0 || shown[i - 1]?.source !== result.source);
            if (row._sb.source.visible !== label)
                row._sb.source.visible = label;
            if (result && !wasVisible && animate) {
                row.opacity = 0;
                row.ease({opacity: 255, duration: RESULTS_DURATION, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            }
            const selected = result !== null && this._offset + i === this._selected;
            const wasSelected = row._sb.selected;
            this._setRowSelected(row, selected);
            // The 'selected' pseudo-class becomes the SELECTED accessible
            // state (St does it), which screen readers announce. Rows are
            // reused: when the selected row stays the same but shows
            // another result (scrolling, new results), the pseudo-class does
            // not change, so the state is toggled to announce it again.
            const key = selected ? resultKey(result) : null;
            if (selected && wasSelected && row._sb.spokenKey !== key) {
                row.remove_accessible_state(Atk.StateType.SELECTED);
                row.add_accessible_state(Atk.StateType.SELECTED);
            }
            row._sb.spokenKey = key;
        });

        const terms = this._searcher?.terms ?? [];
        const empty = this._results.length === 0 && terms.length > 0;
        this._status.visible = empty;
        this._status.text = this._searching ? _('Searching…') : _('No results');
        this._count.text = this._results.length > 0 ? `${this._selected + 1}/${this._results.length}` : '';
        // Moving the selection does not change which rows show, so only
        // new results refit (and cannot cut an ease short). Before and while the bar is still opening, its first results take their
        // height at once: an ease on top of the reveal looks like a jolt.
        if (resultsChanged || this._rows.filter(r => r.visible).length !== visibleBefore)
            this._fitHeight(resultsChanged && animate && this._open && !this._revealTimeline);
        this._moveHighlight(resultsChanged);
    }

    // Everything a row shows of a result.
    _rowKey(result) {
        return [resultKey(result), result.name, result.description, result.sourceName].join('\0');
    }

    // Takes a row's icon out, to keep it in the cache; the row is then
    // refilled when it shows a result again.
    _takeIcon(row) {
        const actor = row._sb.icon.get_child();
        if (actor)
            row._sb.icon.remove_child(actor);
        row._sb.iconKey = null;
        row._sb.key = null;
    }

    _iconFor(result) {
        const key = resultKey(result);
        if (!this._icons.has(key)) {
            let actor = null;
            try {
                actor = result.createIcon(this._config.iconSize);
            } catch (e) {
                // A provider's broken icon costs that icon, not the list.
                console.error(`[search-bar] icon of ${result.id}: ${e}`);
            }
            this._icons.set(key, actor ?? null);
        }
        return this._icons.get(key);
    }

    _fillRow(row, result) {
        const {icon, name, description, source} = row._sb;
        const key = resultKey(result);
        if (row._sb.iconKey !== key) {
            this._takeIcon(row);
            const actor = this._iconFor(result);
            if (actor)
                icon.set_child(actor);
            row._sb.iconKey = key;
        }
        row._sb.key = this._rowKey(result);
        // Text from other programs (window titles, file names): plain text.
        name.text = result.name.replace(/\s+/g, ' ');
        const detail = (result.description ?? '').replace(/\s+/g, ' ').trim();
        description.text = detail;
        // A window of an app with the same title says nothing new below.
        description.visible = this._config.showDescriptions && detail !== '' && detail !== name.text;
        source.text = result.sourceName ?? '';
        // The source too, although the label shows on a source's first row
        // only: a screen reader hears one row at a time.
        row.accessible_name = spokenLabel(name.text, detail, source.text);
    }

    _setRowSelected(row, selected) {
        if (row._sb.selected === selected)
            return;
        row._sb.selected = selected;
        if (selected)
            row.add_style_pseudo_class('selected');
        else
            row.remove_style_pseudo_class('selected');
        row.set_style(selected && this._config.textColor ? `color: ${this._config.textColor};` : null);
        const scale = selected ? this._config.focusScale : 1;
        row._sb.icon.ease({
            scale_x: scale,
            scale_y: scale,
            duration: this._config.duration,
            mode: selected ? Clutter.AnimationMode.EASE_OUT_BACK : Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    // The bar's height follows the rows showing; the search field stays put.
    _fitHeight(animate) {
        const size = this._size;
        const showing = this._drag?.kind === 'resize' && this._drag.started
            ? this._config.rows
            : Math.max(this._rows.filter(r => r.visible).length, this._status.visible ? 1 : 0);
        const list = listHeight(showing, size.rowHeight, size.rowStep - size.rowHeight);
        const pad = PADDING * this._scale;
        const height = Math.round(showing > 0 ? size.top + list + pad : pad * 2 + ENTRY_HEIGHT * this._scale);
        const grip = height - this._grip.height - 4;
        // Every source's answer asks again, mostly for the same height: an
        // ease already going there goes on instead of starting over.
        const target = `${height} ${Math.round(list)} ${grip}`;
        if (target === this._heightTarget)
            return;
        this._heightTarget = target;
        if (animate && this._panel.height > 0) {
            // ease() replaces a transition still running on each property.
            const params = {duration: RESULTS_DURATION, mode: Clutter.AnimationMode.EASE_OUT_QUAD};
            this._list.ease({height: Math.round(list), ...params});
            this._panel.ease({height, ...params});
            this._grip.ease({y: grip, ...params});
        } else {
            // A running ease would go on overriding the value set here.
            this._list.remove_transition('height');
            this._panel.remove_transition('height');
            this._grip.remove_transition('y');
            this._list.height = Math.round(list);
            this._panel.height = height;
            this._grip.y = grip;
        }
    }

    // --- Screen readers ------------------------------------------------------

    // What a screen reader is told about the search: the count, or why the
    // list is empty; nothing before typing.
    _statusMessage() {
        if ((this._searcher?.terms ?? []).length === 0)
            return null;
        const n = this._results.length;
        if (n > 0)
            return ngettext('%d result', '%d results', n).format(n);
        return this._searching ? _('Searching…') : _('No results');
    }

    // The keyboard stays in the field, so the count cannot be read from a
    // focused widget: the field's accessible sends it as an ATK live
    // region notification (ATK 2.50 and later), which the AT-SPI bridge
    // turns into object:announcement and Orca speaks politely, after what
    // it is saying. Only once the reports pause, and never the same text
    // twice in a row.
    _scheduleAnnouncement() {
        this._cancelAnnouncement();
        this._announceTimeoutId = GLib.timeout_add_once(GLib.PRIORITY_DEFAULT, ANNOUNCE_DELAY, () => {
            this._announceTimeoutId = 0;
            const text = this._statusMessage();
            // Cleared text forgets it, so a new search says it again.
            if (text === this._lastAnnouncement || !this._entry)
                return;
            this._lastAnnouncement = text;
            if (text)
                this._entry.get_accessible()?.emit('notification', text, Atk.Live.POLITE);
        });
    }

    _cancelAnnouncement() {
        if (this._announceTimeoutId)
            GLib.source_remove(this._announceTimeoutId);
        this._announceTimeoutId = 0;
    }

    // --- Highlight -----------------------------------------------------------

    _moveHighlight(resultsChanged) {
        const slot = this._selected - this._offset;
        const row = this._rows[slot];
        if (this._selected < 0 || !row?.visible) {
            this._hideHighlight();
            return;
        }
        const size = this._size;
        const box = {x: 0, y: Math.round(slot * size.rowStep), width: this._list.width, height: size.rowHeight};
        if (sameBox(box, this._highlightBox) && this._highlightOpacity > 0)
            return;
        const h = this._highlight;
        // From where it is on screen, even mid-move; nowhere the first time.
        const from = this._highlightBox && this._highlightOpacity > 0
            ? {x: h.x, y: h.y, width: h.width, height: h.height} : null;
        this._highlightBox = box;
        // New results start the highlight on the first row without a trip.
        const animation = resultsChanged && !this._timeline ? 'none' : this._config.animation;
        this._animateHighlight(makeTransition(animation, from, box, {
            curve: this._config.curve,
            motion: this._config.motion,
            fromOpacity: this._highlightOpacity,
            vertical: true,
        }));
    }

    _animateHighlight(transition) {
        this._stopHighlight();
        if (transition.instant || !St.Settings.get().enable_animations) {
            this._applyHighlight(transition.at(1));
            return;
        }
        const timeline = new Clutter.Timeline({actor: this._highlight, duration: this._config.duration});
        timeline.connect('new-frame', () => this._applyHighlight(transition.at(timeline.get_progress())));
        timeline.connect('completed', () => {
            if (this._timeline !== timeline)
                return;
            this._timeline = null;
            this._applyHighlight(transition.at(1));
        });
        this._timeline = timeline;
        this._applyHighlight(transition.at(0));
        timeline.start();
    }

    _applyHighlight({box, opacity, shape}) {
        const h = this._highlight;
        Object.assign(h, {x: box.x, y: box.y, width: box.width, height: box.height});
        this._highlightOpacity = opacity;
        if (shape) {
            const x = Math.floor(shape.bounds.x);
            const y = Math.floor(shape.bounds.y);
            Object.assign(this._drop, {
                x,
                y,
                width: Math.ceil(shape.bounds.x + shape.bounds.width) - x,
                height: Math.ceil(shape.bounds.y + shape.bounds.height) - y,
            });
            this._shape = shape;
            this._drop.show();
            this._drop.queue_repaint();
            h.opacity = 0;
        } else {
            this._shape = null;
            this._drop.hide();
            h.opacity = Math.round(opacity * 255);
        }
    }

    _stopHighlight() {
        this._timeline?.stop();
        this._timeline = null;
        this._highlight?.remove_all_transitions();
    }

    _hideHighlight() {
        this._stopHighlight();
        this._shape = null;
        this._drop.hide();
        this._highlightBox = null;
        this._highlightOpacity = 0;
        this._highlight.ease({
            opacity: 0,
            duration: RESULTS_DURATION,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    // The panel's outline at its bottom-right corner, 4 px inside it, in
    // the grip's text color (the accent color when hovered).
    _drawGrip() {
        const grip = this._grip;
        const [width, height] = grip.get_surface_size();
        const c = grip.get_theme_node().get_foreground_color();
        const cr = grip.get_context();
        const line = (grip.hover ? 3 : 2) * this._scale;
        const radius = Math.max(this._config.panelRadius * this._scale - 4, 0);
        const right = width - line / 2;
        const bottom = height - line / 2;
        cr.setSourceRGBA(c.red / 255, c.green / 255, c.blue / 255, c.alpha / 255);
        cr.setLineWidth(line);
        // Up the right side, round the corner, along the bottom; whatever
        // falls outside the grip is cut by its surface.
        cr.moveTo(right, 0);
        cr.arc(right - radius, bottom - radius, radius, 0, Math.PI / 2);
        cr.lineTo(0, bottom);
        cr.stroke();
        cr.$dispose();
    }

    _drawDrop() {
        const shape = this._shape;
        if (!shape)
            return;
        const node = this._highlight.get_theme_node();
        const rgba = c => [c.red / 255, c.green / 255, c.blue / 255, c.alpha / 255];
        const cr = this._drop.get_context();
        paintShape(cr, offsetShape(shape, this._drop.x, this._drop.y), {
            fill: rgba(node.get_background_color()),
            border: rgba(node.get_border_color(St.Side.TOP)),
            borderWidth: node.get_border_width(St.Side.TOP),
            radius: this._config.radius * this._scale,
        }, this._highlightOpacity);
        cr.$dispose();
    }

    // The highlight's color with its opacity, border and corner radius, as
    // an inline style on top of the stylesheet's accent color.
    _applyHighlightStyle() {
        const {radius, opacity, borderWidth, color} = this._config;
        // color passed parseColor(), so it is exactly #rrggbb.
        let rgb;
        if (color) {
            rgb = hexToRgb(color);
        } else {
            const c = this._highlight.get_theme_node().get_background_color();
            rgb = [c.red, c.green, c.blue];
        }
        this._highlight.set_style(`border-radius: ${radius}px; border-width: ${borderWidth}px; ` +
            `background-color: rgba(${rgb.join(', ')}, ${opacity});`);
    }

    // --- Keyboard, pointer ---------------------------------------------------

    _onKey(event) {
        const key = event.get_key_symbol();
        const control = (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const move = delta => {
            const next = moveSelection(this._selected, delta, this._results.length);
            if (next >= 0)
                this._select(next);
            return Clutter.EVENT_STOP;
        };
        const page = this._config.rows;
        switch (key) {
        case Clutter.KEY_Escape:
            this.close();
            return Clutter.EVENT_STOP;
        case Clutter.KEY_Down:
        case Clutter.KEY_KP_Down:
        case Clutter.KEY_Tab:
            return move(1);
        case Clutter.KEY_Up:
        case Clutter.KEY_KP_Up:
        case Clutter.KEY_ISO_Left_Tab:
            return move(-1);
        case Clutter.KEY_Page_Down:
            return move(page);
        case Clutter.KEY_Page_Up:
            return move(-page);
        case Clutter.KEY_KP_Enter:
            this._activateSelected();
            return Clutter.EVENT_STOP;
        }
        if (control && (key === Clutter.KEY_n || key === Clutter.KEY_j))
            return move(1);
        if (control && (key === Clutter.KEY_p || key === Clutter.KEY_k))
            return move(-1);
        return Clutter.EVENT_PROPAGATE;
    }

    _onScroll(event) {
        const direction = event.get_scroll_direction();
        if (direction === Clutter.ScrollDirection.DOWN)
            this._select(moveSelection(this._selected, 1, this._results.length, false));
        else if (direction === Clutter.ScrollDirection.UP)
            this._select(moveSelection(this._selected, -1, this._results.length, false));
        return Clutter.EVENT_STOP;
    }

    // The results on screen are those of what is typed now, with the apps
    // and system actions in.
    _resultsAreCurrent() {
        return !this._searcher.pending && this._ready &&
            sameTerms(termsFor(this._entry.text), this._resultsTerms);
    }

    // Enter. Results on screen can be those of a few keys ago: the search
    // waits for the typing to pause, and sources answer later. Opening one
    // of them would open something the user did not ask for (the first
    // frequent app, or a system action), so Enter then runs the search now,
    // as GNOME's overview does, and opens the first of its results.
    _activateSelected() {
        if (!this._open || this._activatePending)
            return;
        if (this._resultsAreCurrent()) {
            this._activate(this._results[this._selected]);
            return;
        }
        this._activatePending = true;
        this._activateTimeoutId = GLib.timeout_add_once(GLib.PRIORITY_DEFAULT, ACTIVATE_WAIT, () => {
            this._activateTimeoutId = 0;
            this._resolvePendingActivation(true);
        });
        this._searcher.flush();
        this._resolvePendingActivation(false);
    }

    // Opens the result Enter waited for, once the results are those of the
    // text: at once when the local sources are in and found something, or
    // when every source has answered. When the wait runs out, it opens what
    // the current search found so far; nothing found, nothing opens.
    _resolvePendingActivation(timedOut) {
        if (!this._activatePending)
            return;
        const current = sameTerms(termsFor(this._entry.text), this._resultsTerms) && !this._searcher.pending;
        const found = current && this._results.length > 0;
        const done = current && (this._ready && (found || !this._searching));
        if (!done && !timedOut)
            return;
        this._cancelPendingActivation();
        if (found)
            this._activate(this._results[this._selected]);
    }

    _cancelPendingActivation() {
        this._activatePending = false;
        if (this._activateTimeoutId)
            GLib.source_remove(this._activateTimeoutId);
        this._activateTimeoutId = 0;
    }

    _activate(result) {
        if (!result || !this._open)
            return;
        const searcher = this._searcher;
        this.close();
        try {
            searcher.activate(result);
        } catch (e) {
            console.error(`[search-bar] activating ${result.id}: ${e}\n${e.stack}`);
        }
    }

    _onBackdropPress(event) {
        // get_source() is always null in GNOME 50; the stage knows the actor.
        const target = global.stage.get_event_actor(event);
        if (target === this._root || (this._backdrop && target === this._backdrop)) {
            if (this._config.closeOnClickOutside)
                this.close();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // Dragging the bar by its edge (or its search icon) moves it; dragging
    // the grip at the bottom-right corner resizes it.
    _startDrag(event, kind) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY || !this._open)
            return Clutter.EVENT_PROPAGATE;
        // Presses on the field and the rows keep their own meaning.
        const target = global.stage.get_event_actor(event);
        if (kind === 'move' && ![this._panel, this._handle, this._entryBox].includes(target))
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        // It becomes a drag once the pointer has moved DRAG_THRESHOLD.
        this._drag = {
            kind,
            x,
            y,
            started: false,
            place: {...this._place},
            size: {width: this._config.width, rows: this._config.rows, iconSize: this._config.iconSize,
                textHeight: this._textHeight},
        };
        return Clutter.EVENT_STOP;
    }

    // The pointer shows what a press does: the edge and the magnifier move,
    // the grip resizes, the field takes text, and the rows and the list (not
    // handles) keep the arrow; actors that set none take their parent's.
    // While dragging, every part shows the drag's cursor, since the pointer
    // can be over any of them, or outside the bar over the layer.
    _setCursors(dragging) {
        const C = Clutter.CursorType;
        this._root.set_cursor_type(dragging ?? C.INHERIT);
        this._panel.set_cursor_type(dragging ?? C.MOVE);
        this._handle.set_cursor_type(dragging ?? C.MOVE);
        this._entry.set_cursor_type(dragging ?? C.TEXT);
        this._list.set_cursor_type(dragging ?? C.DEFAULT);
        this._grip.set_cursor_type(dragging ?? C.SE_RESIZE);
    }

    _beginDrag() {
        const drag = this._drag;
        drag.started = true;
        this._panel.add_style_pseudo_class(drag.kind === 'move' ? 'moving' : 'resizing');
        this._setCursors(drag.kind === 'move' ? Clutter.CursorType.MOVE : Clutter.CursorType.SE_RESIZE);
        if (drag.kind === 'resize')
            this._fitHeight(false);
    }

    _onCapturedEvent(event) {
        const type = event.type();
        if (type === Clutter.EventType.MOTION)
            this._pointerMoved = true;
        if (!this._drag)
            return Clutter.EVENT_PROPAGATE;
        if (type === Clutter.EventType.MOTION) {
            const [x, y] = event.get_coords();
            this._dragTo(x - this._drag.x, y - this._drag.y);
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.BUTTON_RELEASE) {
            this._endDrag(true);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _dragTo(dx, dy) {
        const drag = this._drag;
        if (!drag.started) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) < DRAG_THRESHOLD * this._scale)
                return;
            this._beginDrag();
        }
        if (drag.kind === 'move') {
            const area = this._area;
            const size = this._size;
            this._place = {
                x: Math.round(Math.min(Math.max(drag.place.x + dx, area.x), area.x + area.width - size.width)),
                y: Math.round(Math.min(Math.max(drag.place.y + dy, area.y), area.y + area.height - size.height)),
            };
            this._panel.set_position(this._place.x, this._place.y);
            return;
        }
        const maxWidth = (this._area.x + this._area.width - drag.place.x) / this._scale;
        const {width, rows} = resizeBy(drag.size, dx, dy, this._scale, maxWidth);
        if (width === this._config.width && rows === this._config.rows)
            return;
        this._config.width = width;
        this._config.rows = rows;
        this._layout();
        this._offset = scrollOffset(this._results.length, rows, Math.max(this._selected, 0), this._offset);
        this._highlightBox = null;
        this._refresh(false);
    }

    _endDrag(save) {
        const drag = this._drag;
        if (!drag)
            return;
        this._drag = null;
        this._panel?.remove_style_pseudo_class('moving');
        this._panel?.remove_style_pseudo_class('resizing');
        if (this._root)
            this._setCursors(null);
        // A click, or a drag that ended where it started, saves nothing:
        // saving would turn a centered bar into a custom one.
        if (!save || !drag.started)
            return;
        if (drag.kind === 'move') {
            if (this._place.x === drag.place.x && this._place.y === drag.place.y)
                return;
            const custom = customFromPlace(this._area, this._size, this._place.x, this._place.y);
            this._onGeometry?.({x: custom.x, y: custom.y});
        } else {
            if (this._config.width !== drag.size.width || this._config.rows !== drag.size.rows)
                this._onGeometry?.({width: this._config.width, rows: this._config.rows});
            this._fitHeight(this._config.animateResults && St.Settings.get().enable_animations);
        }
    }
}
