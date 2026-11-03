// Highlight geometry and transitions, adapted from Alt Tab Glide for a
// vertical list of results. No GNOME Shell imports, so this module runs in
// the shell, in the preferences (for the live preview) and in tests/unit.js.

// How the highlight travels to the newly selected item.
export const ANIMATIONS = ['slide', 'stretch', 'liquid', 'jelly', 'pop', 'fade', 'none'];
// Styles with their own motion, where the speed curve does not apply.
export const OWN_MOTION = ['liquid', 'jelly', 'none'];
// Speed curves of the other styles.
export const CURVES = ['smooth', 'overshoot', 'bounce', 'elastic', 'linear'];
// Curves whose rebound the "rebound" setting tunes.
export const REBOUND_CURVES = ['overshoot', 'bounce', 'elastic'];

// Share of the duration "fade" spends fading out on the previous item.
export const FADE_OUT = 0.4;
// Share of the duration "pop" spends shrinking on the previous item.
export const POP_OUT = 0.35;
// Share of the liquid's or jelly's duration a highlight that was fading
// takes to become opaque again.
const OPAQUE_AGAIN = 0.3;

/**
 * Tuning of the motion, as the settings store it: whole numbers, mostly
 * percentages. motionFromSettings() turns them into the numbers the code uses.
 */
export const DEFAULT_TUNING = {
    rebound: 50,
    stretchReach: 40,
    liquidViscosity: 50,
    jellyBounce: 50,
    jellyWobbles: 2,
    jellyStretch: 30,
    popSize: 30,
};

const clamp01 = v => Math.min(Math.max(v, 0), 1);
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * Turns the tuning settings into motion parameters.
 *
 * @param {object} tuning values like DEFAULT_TUNING; missing ones use it
 * @returns {object} motion parameters for makeTransition()
 */
export function motionFromSettings(tuning = {}) {
    const s = {...DEFAULT_TUNING, ...tuning};
    const viscosity = clamp01(s.liquidViscosity / 100);
    const bounce = clamp01(s.jellyBounce / 100);
    return {
        // 0 to 1, where 0.5 is the rebound of Clutter's EASE_OUT_BACK.
        rebound: clamp01(s.rebound / 100),
        stretchReach: lerp(0.2, 0.7, clamp01((s.stretchReach - 20) / 50)),
        // More viscous: the head runs further ahead of the tail, and the
        // tail and the neck get thinner. 50 gives the original drop.
        liquidLead: lerp(0.8, 0.3, viscosity),
        liquidTrail: lerp(0.05, 0.35, viscosity),
        liquidTail: lerp(0.05, 0.45, viscosity),
        liquidNeck: lerp(0.3, 0.9, viscosity),
        // Less damping, more bounce. The frequency puts the spring exactly
        // on a turning point at the end, so it settles with no speed left.
        jellyDamping: lerp(8, 2, bounce),
        jellyFrequency: (Math.round(Math.min(Math.max(s.jellyWobbles, 1), 4)) + 0.5) * Math.PI,
        jellyStretch: clamp01(s.jellyStretch / 100),
        popSize: clamp01(s.popSize / 100),
    };
}

export const DEFAULT_MOTION = motionFromSettings();

// The GSettings key of each tuning value.
export const TUNING_KEYS = {
    rebound: 'curve-rebound',
    stretchReach: 'stretch-reach',
    liquidViscosity: 'liquid-viscosity',
    jellyBounce: 'jelly-bounce',
    jellyWobbles: 'jelly-wobbles',
    jellyStretch: 'jelly-stretch',
    popSize: 'pop-size',
};

/**
 * @param {{get_int: function(string): number}} settings the extension's
 *   Gio.Settings, or anything with get_int()
 * @returns {object} motion parameters, see motionFromSettings()
 */
export function readMotion(settings) {
    return motionFromSettings(Object.fromEntries(
        Object.entries(TUNING_KEYS).map(([name, key]) => [name, settings.get_int(key)])));
}

// --- Easing -------------------------------------------------------------------

const easeOutCubic = t => 1 - (1 - t) ** 3;
const easeInOutCubic = t => t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
const easeInOutQuad = t => t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;

const BOUNCES = 6;

/**
 * A ball dropped on the target: it falls, then bounces back BOUNCES times,
 * each bounce `restitution` times as fast as the one before (so its height
 * is restitution² of the previous one). It lands for good exactly at 1.
 *
 * @param {number} restitution 0 to 1
 * @returns {function(number): number} the curve
 */
function bounceCurve(restitution) {
    // Time units where the fall takes 1 and gravity is 2, so the ball hits
    // at speed 2 and bounce k lasts 2 · restitution^k.
    const bounces = Array.from({length: BOUNCES}, (_, k) => 2 * restitution ** (k + 1));
    const total = 1 + bounces.reduce((a, b) => a + b, 0);
    return t => {
        // Summing the bounces back up can fall a hair short of the total.
        if (t >= 1)
            return 1;
        let s = t * total;
        if (s < 1)
            return s * s;
        s -= 1;
        for (const d of bounces) {
            if (s < d)
                return 1 - (d * s - s * s);
            s -= d;
        }
        return 1;
    };
}

/**
 * A speed curve: maps the progress (0 to 1) to how far along the movement
 * is. It starts at 0 and ends at exactly 1; in between, the rebound curves
 * go past 1.
 *
 * @param {string} curve one of CURVES; unknown values are smooth
 * @param {number} rebound 0 to 1; how far overshoot and elastic go past the
 *   target and how high bounce bounces. 0.5 is the usual amount
 * @returns {function(number): number} the curve
 */
export function easing(curve, rebound = 0.5) {
    switch (curve) {
    case 'linear':
        return t => t;
    case 'overshoot': {
        // EASE_OUT_BACK, whose usual constant 1.70158 is rebound 0.5.
        const c1 = 3.40316 * rebound;
        const c3 = c1 + 1;
        return t => 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
    }
    case 'bounce':
        // Rebound 0.5 bounces back a quarter of the way, like
        // easeOutBounce; 0 barely bounces, 1 bounces back 64%.
        return bounceCurve(lerp(0.2, 0.8, rebound));
    case 'elastic': {
        // A rubber band: swings around the target a few times as it settles.
        const amplitude = lerp(0.6, 1.3, rebound);
        const decay = lerp(9, 4, rebound);
        return t => t <= 0 ? 0 : t >= 1 ? 1
            : 1 - amplitude * Math.exp(-decay * t) * Math.cos(4.5 * Math.PI * t) * (1 - t) -
                (1 - amplitude) * (1 - t) ** 3;
    }
    default:
        return easeOutCubic;
    }
}

// --- Boxes --------------------------------------------------------------------

/**
 * Grows a box around its center.
 *
 * @param {{x: number, y: number, width: number, height: number}} box box to grow
 * @param {number} scale 1 keeps the box as it is
 * @returns {{x: number, y: number, width: number, height: number}} new box
 */
export function growBox(box, scale) {
    const width = box.width * scale;
    const height = box.height * scale;
    return {
        x: box.x - (width - box.width) / 2,
        y: box.y - (height - box.height) / 2,
        width,
        height,
    };
}

/**
 * @param {{x: number, y: number, width: number, height: number}} a first box
 * @param {{x: number, y: number, width: number, height: number}} b second box
 * @returns {{x: number, y: number, width: number, height: number}} the
 *   smallest box that holds both
 */
export function unionBox(a, b) {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return {
        x,
        y,
        width: Math.max(a.x + a.width, b.x + b.width) - x,
        height: Math.max(a.y + a.height, b.y + b.height) - y,
    };
}

/**
 * @param {?object} a first box
 * @param {?object} b second box
 * @returns {boolean} both boxes exist and differ by less than half a pixel
 */
export function sameBox(a, b) {
    if (!a || !b)
        return false;
    return ['x', 'y', 'width', 'height'].every(k => Math.abs(a[k] - b[k]) < 0.5);
}

/**
 * @param {object} box a box
 * @returns {object} the same box with x and y (and width and height) swapped
 */
export function transposeBox(box) {
    return {x: box.y, y: box.x, width: box.height, height: box.width};
}

// Interpolates two boxes. A curve going past 1 could turn a shrinking box
// inside out, so the size never goes below 1 pixel.
const lerpBox = (a, b, t) => ({
    x: lerp(a.x, b.x, t),
    y: lerp(a.y, b.y, t),
    width: Math.max(lerp(a.width, b.width, t), 1),
    height: Math.max(lerp(a.height, b.height, t), 1),
});

// Scales a box around its center, but never below 1 pixel, which pop at 0%
// and a curve dipping below 0 would otherwise reach.
function shrinkBox(box, scale) {
    const scaled = growBox(box, scale);
    const width = Math.max(scaled.width, 1);
    const height = Math.max(scaled.height, 1);
    return {x: box.x + (box.width - width) / 2, y: box.y + (box.height - height) / 2, width, height};
}

// --- Transitions --------------------------------------------------------------

/**
 * A transition of the highlight from one box to another.
 *
 * @param {string} animation one of ANIMATIONS; unknown values slide
 * @param {?object} from where the highlight is now, or null when it has not
 *   been placed yet (it then appears directly on `to`)
 * @param {object} to box of the newly selected item
 * @param {object} [options] options
 * @param {string} [options.curve] one of CURVES
 * @param {object} [options.motion] from motionFromSettings()
 * @param {number} [options.fromOpacity] opacity the highlight has now, 0 to 1
 * @param {boolean} [options.vertical] the items are stacked: every style
 *   then moves along y as it would along x. The drop shape stays in swapped
 *   coordinates, marked `vertical`, and drawing.js swaps them back
 * @returns {{instant: boolean, at: function(number): {box: object,
 *   opacity: number, shape: ?object}}} `at(t)` gives, for a progress from
 *   0 to 1, the box of the highlight, its opacity, and for liquid the shape
 *   of the drop (null otherwise, and at the end). At 1 it is `to`, opaque.
 *   `instant` transitions only need `at(1)`.
 */
export function makeTransition(animation, from, to, options = {}) {
    if (options.vertical) {
        // Run the horizontal transition with x and y swapped, and swap back.
        const inner = makeTransition(animation, from && transposeBox(from), transposeBox(to),
            {...options, vertical: false});
        return {
            instant: inner.instant,
            at: t => {
                const frame = inner.at(t);
                return {
                    box: transposeBox(frame.box),
                    opacity: frame.opacity,
                    shape: frame.shape && {...frame.shape, vertical: true, bounds: transposeBox(frame.shape.bounds)},
                };
            },
        };
    }
    const {curve = 'smooth', motion = DEFAULT_MOTION, fromOpacity = 1} = options;
    const ease = easing(curve, motion.rebound);
    const done = {box: to, opacity: 1, shape: null};
    const transition = at => ({instant: false, at: t => (t >= 1 ? done : at(clamp01(t)))});

    if (!from || animation === 'none')
        return {instant: true, at: () => done};
    const moves = !sameBox(from, to);
    // Styles that stay visible become opaque again quickly if a fade or pop
    // was interrupted.
    const opacity = (t, share = OPAQUE_AGAIN) => lerp(fromOpacity, 1, clamp01(t / share));

    if (animation === 'stretch' && moves) {
        const reach = motion.stretchReach;
        const both = unionBox(from, to);
        return transition(t => ({
            box: t < reach
                ? lerpBox(from, both, easeInOutQuad(t / reach))
                : lerpBox(both, to, ease((t - reach) / (1 - reach))),
            opacity: opacity(t, reach),
            shape: null,
        }));
    }
    if (animation === 'fade' && moves) {
        return transition(t => t < FADE_OUT
            ? {box: from, opacity: lerp(fromOpacity, 0, easeInOutQuad(t / FADE_OUT)), shape: null}
            : {box: to, opacity: clamp01(ease((t - FADE_OUT) / (1 - FADE_OUT))), shape: null});
    }
    if (animation === 'pop' && moves) {
        const small = motion.popSize;
        return transition(t => {
            if (t < POP_OUT) {
                const p = easeInOutQuad(t / POP_OUT);
                return {box: shrinkBox(from, lerp(1, small, p)), opacity: lerp(fromOpacity, 0, p), shape: null};
            }
            const p = ease((t - POP_OUT) / (1 - POP_OUT));
            return {box: shrinkBox(to, lerp(small, 1, p)), opacity: clamp01(p * 2), shape: null};
        });
    }
    if (animation === 'liquid') {
        return transition(t => {
            const shape = liquidShape(from, to, t, motion);
            return {box: shape.bounds, opacity: opacity(t), shape};
        });
    }
    if (animation === 'jelly')
        return transition(t => ({box: jellyBox(from, to, t, motion), opacity: opacity(t), shape: null}));
    return transition(t => ({box: lerpBox(from, to, ease(t)), opacity: opacity(t), shape: null}));
}

/**
 * Shape of the "liquid" drop at a given moment: a head that runs ahead to
 * the next item, a tail that follows, smaller, and a bridge between their
 * centers, thinnest in the middle. drawing.js paints it.
 *
 * @param {object} from box where the drop starts
 * @param {object} to box where it ends
 * @param {number} t progress from 0 to 1
 * @param {object} [motion] from motionFromSettings()
 * @returns {{head: object, tail: object, neck: number, bounds: object}} the
 *   head and tail boxes, the height of the bridge at its middle, and the
 *   box that holds the whole drop. At 0 and 1 all of it is `from` or `to`.
 */
export function liquidShape(from, to, t, motion = DEFAULT_MOTION) {
    t = clamp01(t);
    const {liquidLead, liquidTrail, liquidTail, liquidNeck} = motion;
    const lead = easeOutCubic(clamp01(t / liquidLead));
    const trail = easeInOutCubic(clamp01((t - liquidTrail) / (1 - liquidTrail)));
    const head = lerpBox(from, to, lead);
    const distance = Math.abs(to.x + to.width / 2 - (from.x + from.width / 2));
    // The tail thins out while it is pulled, and is whole again on arrival.
    // Moves shorter than an item thin it less; staying in place, not at all.
    const pull = clamp01(distance / Math.max(to.width, 1));
    const tail = growBox(lerpBox(from, to, trail), 1 - liquidTail * pull * Math.sin(Math.PI * trail));
    // How far apart head and tail are, from 0 (together) to 1 (a whole move).
    const apart = distance > 0
        ? clamp01(Math.abs(head.x + head.width / 2 - (tail.x + tail.width / 2)) / distance) : 0;
    const neck = Math.min(head.height, tail.height) * (1 - liquidNeck * apart);
    return {head, tail, neck, bounds: unionBox(head, tail)};
}

/**
 * Position of the "jelly" spring: 0 at the start, exactly 1 at the end, and
 * past 1 for a while in between (the overshoot).
 *
 * @param {number} t progress from 0 to 1
 * @param {object} [motion] from motionFromSettings()
 * @returns {number} position, where 1 is the target
 */
export function springPosition(t, motion = DEFAULT_MOTION) {
    const {jellyDamping: a, jellyFrequency: w} = motion;
    return 1 - Math.exp(-a * t) * Math.cos(w * t) * (1 - t);
}

/**
 * Speed of the spring, as a share of its speed at the start (its fastest).
 * It is 0 at the end, so the jelly settles unstretched.
 *
 * @param {number} t progress from 0 to 1
 * @param {object} [motion] from motionFromSettings()
 * @returns {number} speed from 0 to about 1
 */
export function springSpeed(t, motion = DEFAULT_MOTION) {
    const {jellyDamping: a, jellyFrequency: w} = motion;
    const e = Math.exp(-a * t);
    const derivative = e * ((a * Math.cos(w * t) + w * Math.sin(w * t)) * (1 - t) + Math.cos(w * t));
    return Math.min(Math.abs(derivative) / (a + 1), 1);
}

// Share of the duration over which the jelly's stretch eases in: the spring
// is fastest at the start, and the stretch must not appear on the first frame.
export const JELLY_RAMP = 0.1;

function jellyBox(from, to, t, motion) {
    const position = springPosition(t, motion);
    // The size follows the spring too, but never past the target's.
    const size = clamp01(position);
    const width = lerp(from.width, to.width, size);
    const height = lerp(from.height, to.height, size);
    // Stretch along the movement while fast, and get thinner across it.
    const stretch = 1 + motion.jellyStretch * springSpeed(t, motion) * clamp01(t / JELLY_RAMP);
    const horizontal = Math.abs(to.x - from.x) >= Math.abs(to.y - from.y);
    const w = horizontal ? width * stretch : width / stretch;
    const h = horizontal ? height / stretch : height * stretch;
    const cx = lerp(from.x + from.width / 2, to.x + to.width / 2, position);
    const cy = lerp(from.y + from.height / 2, to.y + to.height / 2, position);
    return {x: cx - w / 2, y: cy - h / 2, width: w, height: h};
}
