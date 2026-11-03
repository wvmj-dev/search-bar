// How the bar appears and disappears. No GNOME Shell imports, so the shell,
// the preferences preview and tests/unit.js share it.
import {easing} from './geometry.js';

// Ways the bar can appear; it disappears the same way, backwards.
export const REVEALS = ['zoom', 'slide', 'unfold', 'fade', 'none'];
// Closing takes this share of the opening's duration: getting out of the
// way should be quicker than arriving.
export const CLOSE_SHARE = 0.7;

const clamp01 = v => Math.min(Math.max(v, 0), 1);
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * What the bar looks like at a point of its reveal.
 *
 * @param {string} style one of REVEALS; unknown values fade
 * @param {number} value 0 hidden, 1 shown; a curve with rebound goes a
 *   little past 1 (or below 0) on the way
 * @param {number} [amount] 0 to 100, how far the bar travels or how small it
 *   starts; 50 is the hand-tuned look
 * @returns {{opacity: number, scaleX: number, scaleY: number, dy: number,
 *   pivotY: number}} opacity 0 to 1, scale around (0.5, pivotY), and a
 *   vertical offset in logical pixels
 */
export function revealFrame(style, value, amount = 50) {
    const a = clamp01(amount / 100);
    const frame = {opacity: 1, scaleX: 1, scaleY: 1, dy: 0, pivotY: 0.5};
    switch (style) {
    case 'none':
        return value > 0 ? frame : {...frame, opacity: 0};
    case 'zoom': {
        // 50 starts at 90%, the size GNOME's own dialogs grow from.
        const scale = lerp(lerp(0.98, 0.82, a), 1, value);
        return {...frame, opacity: clamp01(value * 1.6), scaleX: scale, scaleY: scale};
    }
    case 'slide':
        // Drops in from above: 48 px at 50.
        return {...frame, opacity: clamp01(value * 1.6), dy: -(1 - value) * lerp(8, 88, a)};
    case 'unfold':
        // Opens downwards from its top edge, like a menu.
        return {...frame, opacity: clamp01(value * 3), scaleY: Math.max(lerp(lerp(0.6, 0, a), 1, value), 0.01),
            pivotY: 0};
    default:
        return {...frame, opacity: clamp01(value)};
    }
}

/**
 * The reveal's progress over time, starting from wherever it is now, so
 * closing while it opens (or opening while it closes) never jumps.
 *
 * @param {number} from value now, 0 to 1
 * @param {boolean} opening true to go to 1, false to go to 0
 * @param {string} curve speed curve of the opening (geometry.js CURVES)
 * @param {number} rebound 0 to 1, see geometry.js easing()
 * @returns {function(number): number} value for a progress from 0 to 1;
 *   exactly the target at 1
 */
export function revealMotion(from, opening, curve, rebound = 0.5) {
    if (opening) {
        const ease = easing(curve, rebound);
        return t => (t >= 1 ? 1 : from + (1 - from) * ease(clamp01(t)));
    }
    // Closing accelerates away and never rebounds: a bar that bounced back
    // while leaving would look like it changed its mind.
    return t => (t >= 1 ? 0 : from * (1 - clamp01(t) ** 2));
}
