import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {hexToRgb, parseColor} from './color.js';
import {boxShape, offsetShape, paintShape} from './drawing.js';
import {makeTransition, readMotion} from './geometry.js';
import {CLOSE_SHARE, revealFrame, revealMotion} from './reveal.js';

const ROWS = 4;
const ROW_HEIGHT = 30;
const SPACING = 4;
const PADDING = 10;
const ENTRY = 30;
const WIDTH = 340;
// Room above and below the bar, so slide and overshoot stay in view.
const MARGIN = 14;
// Row the highlight goes to next, in turn: neighbours both ways and long
// jumps. After the last one the bar closes and opens again.
const SEQUENCE = [1, 2, 3, 1, 0, 3, 0];
// Pause after each move or reveal, in milliseconds.
const PAUSE = 650;
const DEFAULT_ACCENT = [0x35 / 255, 0x84 / 255, 0xe4 / 255];
const SURFACE = [0x2e / 255, 0x2e / 255, 0x33 / 255];
const FIELD = [0x3a / 255, 0x3a / 255, 0x3f / 255];
const ICON = [0x5e / 255, 0x5c / 255, 0x64 / 255];
const TEXT = [1, 1, 1, 0.55];
const NONE = [0, 0, 0, 0];
const PANEL_HEIGHT = 2 * PADDING + ENTRY + SPACING + ROWS * ROW_HEIGHT + (ROWS - 1) * SPACING;

/**
 * A small search bar in the preferences that selects its rows in a loop,
 * then closes and opens again, so the look and the motion can be tuned
 * while watching. It moves through geometry.js and reveal.js and paints
 * through drawing.js, like the real bar.
 */
export const BarPreview = GObject.registerClass(
class BarPreview extends Gtk.DrawingArea {
    _init(settings) {
        super._init({
            content_width: WIDTH + 2 * MARGIN,
            content_height: PANEL_HEIGHT + 2 * MARGIN,
            halign: Gtk.Align.CENTER,
            margin_top: 6,
            margin_bottom: 6,
        });
        this._settings = settings;
        this._step = 0;
        this._selected = 0;
        this._previous = 0;
        this._transition = null;
        // Frame clock time, in microseconds, when the current phase started.
        this._start = 0;
        this._now = 0;
        // 'move' between rows, then 'close', 'closed' and 'open'.
        this._phase = 'move';
        this._reveal = 1;
        this._revealMotion = null;
        // The tick callback runs only while something moves; in the pauses
        // between moves a timeout brings it back.
        this._tickId = 0;
        this._resumeId = 0;
        this._readSettings();

        // Any change starts again on the next frame, to show it at once.
        // (connectObject() only exists in the shell, not in the preferences.)
        const settingsId = settings.connect('changed', () => {
            this._readSettings();
            this._start = 0;
            this._phase = 'move';
            this._reveal = 1;
            this._resume();
        });
        const style = Adw.StyleManager.get_default();
        const accentId = style.connect('notify::accent-color', () => this.queue_draw());
        // Hidden (another page), it waits for nothing: the tick callback,
        // which only runs while the preview is on screen, takes over again
        // when it shows.
        this.connect('unmap', () => this._resume());
        this.connect('destroy', () => {
            settings.disconnect(settingsId);
            style.disconnect(accentId);
            this._cancelResume();
            if (this._tickId)
                this.remove_tick_callback(this._tickId);
            this._tickId = 0;
        });

        this.set_draw_func((_area, cr) => this._draw(cr));
        this._resume();
    }

    // Runs the tick callback again, from now.
    _resume() {
        this._cancelResume();
        if (!this._tickId)
            this._tickId = this.add_tick_callback((_widget, clock) => this._tick(clock.get_frame_time()));
    }

    _cancelResume() {
        if (this._resumeId)
            GLib.source_remove(this._resumeId);
        this._resumeId = 0;
    }

    _readSettings() {
        const s = this._settings;
        this._config = {
            animation: s.get_string('animation'),
            duration: s.get_int('animation-duration'),
            curve: s.get_string('animation-curve'),
            motion: readMotion(s),
            color: parseColor(s.get_string('highlight-color')),
            opacity: s.get_int('highlight-opacity') / 100,
            radius: Math.min(s.get_int('corner-radius'), ROW_HEIGHT / 2),
            borderWidth: s.get_int('border-width'),
            focusScale: s.get_int('focus-scale') / 100,
            panelRadius: Math.min(s.get_int('panel-radius'), 24),
            panelOpacity: s.get_int('panel-opacity') / 100,
            openAnimation: s.get_string('open-animation'),
            openDuration: s.get_int('open-duration'),
            openCurve: s.get_string('open-curve'),
            revealAmount: s.get_int('reveal-amount'),
        };
    }

    _rowBox(index) {
        return {
            x: MARGIN + PADDING,
            y: MARGIN + PADDING + ENTRY + SPACING + index * (ROW_HEIGHT + SPACING),
            width: WIDTH - 2 * PADDING,
            height: ROW_HEIGHT,
        };
    }

    _animations() {
        return Gtk.Settings.get_default().gtk_enable_animations;
    }

    _tick(now) {
        this._now = now;
        const elapsed = (now - this._start) / 1000;
        const config = this._config;
        const closeTime = config.openDuration * CLOSE_SHARE;
        if (!this._start) {
            this._start = now;
            this._transition = null;
        } else if (this._phase === 'move' && elapsed >= config.duration + PAUSE) {
            if (this._step > 0 && this._step % SEQUENCE.length === 0 && config.openAnimation !== 'none') {
                this._phase = 'close';
                this._revealMotion = revealMotion(1, false, config.openCurve, config.motion.rebound);
                this._step++;
            } else {
                // Next move, from wherever the highlight is.
                this._previous = this._selected;
                this._selected = SEQUENCE[this._step++ % SEQUENCE.length];
                const from = this._frame()?.box ?? this._rowBox(this._previous);
                this._transition = makeTransition(config.animation, from, this._rowBox(this._selected), {
                    curve: config.curve,
                    motion: config.motion,
                    vertical: true,
                });
            }
            this._start = now;
        } else if (this._phase === 'close' && elapsed >= closeTime) {
            this._phase = 'closed';
            this._reveal = 0;
            this._start = now;
        } else if (this._phase === 'closed' && elapsed >= PAUSE / 2) {
            this._phase = 'open';
            this._revealMotion = revealMotion(0, true, config.openCurve, config.motion.rebound);
            // It opens on the first row, as the real bar does.
            this._selected = this._previous = 0;
            this._transition = null;
            this._start = now;
        } else if (this._phase === 'open' && elapsed >= config.openDuration) {
            this._phase = 'move';
            this._reveal = 1;
            // Wait the move's duration too, so the pause after it is whole.
            this._start = now - config.duration * 1000;
        }
        if (this._phase === 'close' || this._phase === 'open') {
            const length = this._phase === 'close' ? closeTime : config.openDuration;
            const t = this._animations() ? Math.min(elapsed / length, 1) : 1;
            this._reveal = this._revealMotion(t);
        }
        this.queue_draw();

        // Nothing moves until the pause ends: draw this frame, then sleep
        // instead of redrawing the same picture every frame.
        const since = (now - this._start) / 1000;
        let wait = 0;
        if (this._phase === 'move' && this._progress() >= 1)
            wait = config.duration + PAUSE - since;
        else if (this._phase === 'closed')
            wait = PAUSE / 2 - since;
        if (wait < 20)
            return GLib.SOURCE_CONTINUE;
        this._tickId = 0;
        this._resumeId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.ceil(wait), () => {
            this._resumeId = 0;
            this._resume();
            return GLib.SOURCE_REMOVE;
        });
        return GLib.SOURCE_REMOVE;
    }

    // Progress of the current move, 0 to 1; 1 with animations off.
    _progress() {
        if (!this._transition || this._transition.instant || !this._animations() || this._phase !== 'move')
            return 1;
        return Math.min((this._now - this._start) / 1000 / this._config.duration, 1);
    }

    _frame() {
        return this._transition?.at(this._progress()) ?? null;
    }

    _draw(cr) {
        const config = this._config;
        const frame = revealFrame(config.openAnimation, this._reveal, config.revealAmount);
        if (frame.opacity <= 0)
            return;
        const height = PANEL_HEIGHT;
        const panel = {x: MARGIN, y: MARGIN, width: WIDTH, height};
        const px = MARGIN + WIDTH / 2;
        const py = MARGIN + height * frame.pivotY;

        cr.save();
        cr.translate(px, py + frame.dy * 0.6);
        cr.scale(frame.scaleX, frame.scaleY);
        cr.translate(-px, -py);
        cr.pushGroup();

        paintShape(cr, boxShape(panel), {fill: [...SURFACE, config.panelOpacity], border: [1, 1, 1, 0.08],
            borderWidth: 1, radius: config.panelRadius});
        const field = {x: MARGIN + PADDING, y: MARGIN + PADDING, width: WIDTH - 2 * PADDING, height: ENTRY};
        paintShape(cr, boxShape(field), {fill: [...FIELD, 1], border: NONE, borderWidth: 0, radius: 12});
        // A magnifier and a few typed letters.
        cr.setSourceRGBA(...TEXT);
        cr.setLineWidth(1.6);
        cr.arc(field.x + 15, field.y + 13, 5, 0, 2 * Math.PI);
        cr.stroke();
        cr.moveTo(field.x + 18.5, field.y + 16.5);
        cr.lineTo(field.x + 22, field.y + 20);
        cr.stroke();
        paintShape(cr, boxShape({x: field.x + 32, y: field.y + 11, width: 54, height: 8}),
            {fill: TEXT, border: NONE, borderWidth: 0, radius: 4});

        const t = this._progress();
        const move = this._frame() ?? {box: this._rowBox(this._selected), opacity: 1, shape: null};
        const [r, g, b] = config.color ? hexToRgb(config.color).map(c => c / 255) : this._accent();
        paintShape(cr, move.shape ? offsetShape(move.shape, 0, 0) : boxShape(move.box), {
            fill: [r, g, b, config.opacity],
            border: [1, 1, 1, 0.65],
            borderWidth: config.borderWidth,
            radius: config.radius,
        }, move.opacity);

        // The rows, in front of the highlight: the selected one's icon
        // grows and the previous one's shrinks back, as in the shell.
        const grow = 1 - (1 - t) ** 3;
        for (let i = 0; i < ROWS; i++) {
            const box = this._rowBox(i);
            let scale = 1;
            if (i === this._selected)
                scale = 1 + (config.focusScale - 1) * grow;
            else if (i === this._previous)
                scale = config.focusScale - (config.focusScale - 1) * grow;
            const size = 18 * scale;
            const icon = {x: box.x + 10 + (18 - size) / 2, y: box.y + (ROW_HEIGHT - size) / 2, width: size, height: size};
            paintShape(cr, boxShape(icon), {fill: [...ICON, 1], border: NONE, borderWidth: 0, radius: 5});
            const line = {x: box.x + 38, y: box.y + 11, width: 70 + ((i * 37) % 60), height: 8};
            paintShape(cr, boxShape(line), {fill: TEXT, border: NONE, borderWidth: 0, radius: 4});
        }

        cr.popGroupToSource();
        cr.paintWithAlpha(frame.opacity);
        cr.restore();
    }

    _accent() {
        const style = Adw.StyleManager.get_default();
        const accent = style.get_accent_color_rgba?.();
        return accent ? [accent.red, accent.green, accent.blue] : DEFAULT_ACCENT;
    }
});
