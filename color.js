// Color helpers; no GNOME Shell imports, so tests/unit.js can load this.

// GNOME's dark surface, which the bar's background is made of.
export const SURFACE = [0x2e, 0x2e, 0x33];

/**
 * @param {string} value color from the settings
 * @returns {?string} the color as #rrggbb, or null if it is not one. Only
 *   this exact form ever reaches an inline style.
 */
export function parseColor(value) {
    return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : null;
}

/**
 * @param {string} hex color as #rrggbb
 * @returns {number[]} its red, green and blue, 0 to 255
 */
export function hexToRgb(hex) {
    return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
}

/**
 * @param {string} hex color as #rrggbb
 * @returns {string} black or white, whichever reads better on the color
 */
export function contrastColor(hex) {
    const [r, g, b] = hexToRgb(hex);
    return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? '#000000' : '#ffffff';
}

/**
 * The color a translucent highlight shows on the bar, for choosing its
 * text color: a light color at low opacity looks dark there.
 *
 * @param {string} hex color as #rrggbb
 * @param {number} opacity 0 to 1
 * @param {number[]} surface red, green and blue under it, 0 to 255
 * @returns {string} the mixed color as #rrggbb
 */
export function blendOver(hex, opacity, surface) {
    const a = Math.min(Math.max(opacity, 0), 1);
    return `#${hexToRgb(hex).map((c, i) => Math.round(c * a + surface[i] * (1 - a))
        .toString(16).padStart(2, '0')).join('')}`;
}
