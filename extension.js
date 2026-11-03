import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {SearchBar} from './bar.js';
import {blendOver, contrastColor, parseColor, SURFACE} from './color.js';
import {readMotion} from './geometry.js';

// The settings key of the shortcut, which is also its keybinding name in
// mutter. Keybinding names are global across the whole shell, so it carries
// the extension's name: a generic one (toggle-shortcut) is shared with
// other extensions, and the second one to register it gets no shortcut.
const SHORTCUT = 'search-bar-toggle';

export default class SearchBarExtension extends Extension {
    // Everything the extension creates starts here, and nothing before.
    // While the bar is closed, the extension is only a keybinding.
    enable() {
        this._settings = this.getSettings();
        this._bar = null;
        // A registration left behind (by a disable() that did not finish)
        // makes adding fail: mutter keeps the old one, with its old
        // handler. Then remove it and add ours again.
        if (this._addShortcut() === Meta.KeyBindingAction.NONE) {
            Main.wm.removeKeybinding(SHORTCUT);
            if (this._addShortcut() === Meta.KeyBindingAction.NONE)
                console.error(`[${this.uuid}] could not register the shortcut ${this._settings.get_strv(SHORTCUT)}`);
        }
        // A new monitor layout would leave the bar in the wrong place.
        Main.layoutManager.connectObject('monitors-changed', () => {
            this._bar?.destroy();
            this._bar = null;
        }, this);
    }

    _addShortcut() {
        return Main.wm.addKeybinding(SHORTCUT, this._settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
            () => this.toggle());
    }

    // Undoes everything enable() did, in reverse order, and drops every
    // reference. Works with the bar open: it goes at once.
    disable() {
        Main.layoutManager.disconnectObject(this);
        try {
            this._bar?.destroy();
        } catch (e) {
            // Whatever happens to the bar, the shortcut must go.
            console.error(`[${this.uuid}] ${e}\n${e.stack}`);
        }
        this._bar = null;
        Main.wm.removeKeybinding(SHORTCUT);
        this._settings = null;
    }

    /** Opens the bar, or closes it when it is open. */
    toggle() {
        try {
            if (this._bar?.isOpen) {
                this._bar.close();
                return;
            }
            // Never on top of a dialog, a menu or the lock screen.
            if (Main.actionMode !== Shell.ActionMode.NORMAL && Main.actionMode !== Shell.ActionMode.OVERVIEW)
                return;
            // Reopening while it closes continues from where it is.
            if (!this._bar) {
                const bar = new SearchBar(this._readConfig(), {
                    onClosed: () => {
                        if (this._bar === bar)
                            this._bar = null;
                    },
                    onGeometry: geometry => this._saveGeometry(geometry),
                });
                this._bar = bar;
            }
            this._bar.open();
        } catch (e) {
            // A bug here must never leave a grab or a stray actor behind.
            console.error(`[${this.uuid}] ${e}\n${e.stack}`);
            this._bar?.destroy();
            this._bar = null;
        }
    }

    // The settings as plain values, read once per opening. parseColor()
    // returns null for anything but #rrggbb, so a setting can never inject
    // CSS into an inline style; numbers come from get_int().
    _readConfig() {
        const s = this._settings;
        const color = parseColor(s.get_string('highlight-color'));
        const opacity = s.get_int('highlight-opacity') / 100;
        return {
            width: s.get_int('width'),
            rows: s.get_int('visible-rows'),
            iconSize: s.get_int('icon-size'),
            fontSize: s.get_int('font-size'),
            showDescriptions: s.get_boolean('show-descriptions'),
            showSource: s.get_boolean('show-source'),
            color,
            // The text sits on the color as it shows over the bar: a light
            // color at low opacity looks dark and needs light text.
            textColor: color ? contrastColor(blendOver(color, opacity, SURFACE)) : null,
            opacity,
            radius: s.get_int('corner-radius'),
            borderWidth: s.get_int('border-width'),
            focusScale: s.get_int('focus-scale') / 100,
            panelRadius: s.get_int('panel-radius'),
            panelOpacity: s.get_int('panel-opacity') / 100,
            backdropOpacity: s.get_int('backdrop-opacity') / 100,
            openAnimation: s.get_string('open-animation'),
            openDuration: s.get_int('open-duration'),
            openCurve: s.get_string('open-curve'),
            revealAmount: s.get_int('reveal-amount'),
            animation: s.get_string('animation'),
            duration: s.get_int('animation-duration'),
            curve: s.get_string('animation-curve'),
            motion: readMotion(s),
            animateResults: s.get_boolean('animate-results'),
            monitor: s.get_string('monitor'),
            position: s.get_string('position'),
            custom: {x: s.get_double('custom-x'), y: s.get_double('custom-y')},
            closeOnClickOutside: s.get_boolean('close-on-click-outside'),
            emptyQuery: s.get_string('empty-query'),
            perSource: s.get_int('results-per-source'),
            total: s.get_int('max-results'),
            delay: s.get_int('search-delay'),
            selectOnHover: s.get_boolean('select-on-hover'),
            disabled: s.get_strv('disabled-sources'),
        };
    }

    _saveGeometry({x, y, width, rows}) {
        const s = this._settings;
        if (!s?.get_boolean('remember-geometry'))
            return;
        // One write to dconf for all the keys, not one each: every write
        // wakes dconf and everything that watches these settings.
        s.delay();
        try {
            if (x !== undefined) {
                s.set_double('custom-x', x);
                s.set_double('custom-y', y);
                s.set_string('position', 'custom');
            }
            if (width !== undefined) {
                s.set_int('width', width);
                s.set_int('visible-rows', rows);
            }
        } finally {
            s.apply();
        }
    }
}
