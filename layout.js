// Where the bar goes and how big it is. No GNOME Shell imports, so
// tests/unit.js checks it and the preferences can share it.

// Where the bar appears on its monitor.
export const POSITIONS = ['center', 'top', 'bottom', 'custom'];
// Which monitor it appears on.
export const MONITORS = ['pointer', 'focused', 'primary'];

// Logical pixels; the shell multiplies them by the scale factor.
export const PADDING = 12;
export const SPACING = 4;
export const ENTRY_HEIGHT = 44;
export const ROW_PADDING = 8;
// Share of the monitor's height kept free above (top) or below (bottom).
const EDGE_SHARE = 0.12;

// Limits for resizing with the mouse; the same as the schema's ranges.
export const WIDTH_RANGE = [320, 1600];
export const ROWS_RANGE = [1, 20];

const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

/**
 * @param {object} config sizes from the settings, in logical pixels
 * @param {number} config.width width of the bar
 * @param {number} config.rows most results shown at once
 * @param {number} config.iconSize size of a result's icon
 * @param {number} [config.textHeight] height of a result's text (name and
 *   description) as the theme draws it, in physical pixels; a row is as
 *   tall as the taller of the icon and the text
 * @param {number} [scale] the monitor's scale factor
 * @returns {object} physical sizes: the bar's width and height when every
 *   row shows (`height`), a row's height and its step to the next row, and
 *   the space above the first row
 */
export function barSize({width, rows, iconSize, textHeight = 0}, scale = 1) {
    const rowHeight = Math.max(iconSize * scale, textHeight) + 2 * ROW_PADDING * scale;
    const rowStep = rowHeight + SPACING * scale;
    const top = (PADDING + ENTRY_HEIGHT + SPACING) * scale;
    return {
        width: Math.round(width * scale),
        height: Math.round(top + listHeight(rows, rowHeight, SPACING * scale) + PADDING * scale),
        rowHeight: Math.round(rowHeight),
        rowStep,
        top,
    };
}

/**
 * @param {number} count rows showing
 * @param {number} rowHeight height of a row
 * @param {number} spacing space between rows
 * @returns {number} height of the list of results; 0 with no rows
 */
export function listHeight(count, rowHeight, spacing) {
    return count > 0 ? count * rowHeight + (count - 1) * spacing : 0;
}

/**
 * Places the bar on its monitor. The place is computed for the bar with all
 * its rows, so the search field stays still while results come and go.
 *
 * @param {{x: number, y: number, width: number, height: number}} area the
 *   monitor's work area
 * @param {{width: number, height: number}} size from barSize()
 * @param {string} position one of POSITIONS
 * @param {{x: number, y: number}} custom for 'custom': 0 to 100, how far
 *   along the free space the bar sits
 * @returns {{x: number, y: number}} the top-left corner, in whole pixels,
 *   always inside the area
 */
export function placeBar(area, size, position, custom = {x: 50, y: 50}) {
    const freeX = Math.max(area.width - size.width, 0);
    const freeY = Math.max(area.height - size.height, 0);
    let x = area.x + freeX / 2;
    let y = area.y + freeY / 2;
    if (position === 'top')
        y = area.y + Math.min(area.height * EDGE_SHARE, freeY);
    else if (position === 'bottom')
        y = area.y + freeY - Math.min(area.height * EDGE_SHARE, freeY);
    else if (position === 'custom') {
        x = area.x + freeX * clamp(custom.x, 0, 100) / 100;
        y = area.y + freeY * clamp(custom.y, 0, 100) / 100;
    }
    return {
        x: Math.round(clamp(x, area.x, area.x + freeX)),
        y: Math.round(clamp(y, area.y, area.y + freeY)),
    };
}

/**
 * The custom position that puts the bar at a corner, for saving where it
 * was dragged to. placeBar() of the result gives that corner back (to the
 * pixel), and it stays right when the resolution changes.
 *
 * @param {object} area the monitor's work area
 * @param {object} size from barSize()
 * @param {number} x left of the bar
 * @param {number} y top of the bar
 * @returns {{x: number, y: number}} 0 to 100 each, rounded to 0.01
 */
export function customFromPlace(area, size, x, y) {
    const share = (v, start, free) => free > 0
        ? Math.round(clamp((v - start) / free, 0, 1) * 10000) / 100 : 50;
    return {
        x: share(x, area.x, area.width - size.width),
        y: share(y, area.y, area.height - size.height),
    };
}

/**
 * The size after dragging the resize grip.
 *
 * @param {{width: number, rows: number, iconSize: number}} start sizes when
 *   the drag started, in logical pixels
 * @param {number} dx how far the pointer moved right, in physical pixels
 * @param {number} dy how far it moved down
 * @param {number} [scale] the monitor's scale factor
 * @param {number} [maxWidth] widest that fits the monitor, logical pixels
 * @returns {{width: number, rows: number}} within the schema's ranges; the
 *   rows snap to whole rows
 */
export function resizeBy(start, dx, dy, scale = 1, maxWidth = WIDTH_RANGE[1]) {
    const step = barSize(start, scale).rowStep;
    const widest = Math.max(Math.min(WIDTH_RANGE[1], maxWidth), WIDTH_RANGE[0]);
    return {
        width: Math.round(clamp(start.width + dx / scale, WIDTH_RANGE[0], widest)),
        rows: clamp(start.rows + Math.round(dy / step), ROWS_RANGE[0], ROWS_RANGE[1]),
    };
}

/**
 * The first result shown, so that the selected one is visible: the list
 * scrolls only when the selection would leave it, like rofi's.
 *
 * @param {number} count results
 * @param {number} rows rows shown at once
 * @param {number} selected index of the selected result
 * @param {number} offset first result shown now
 * @returns {number} first result to show
 */
export function scrollOffset(count, rows, selected, offset) {
    const last = Math.max(count - rows, 0);
    if (selected < offset)
        offset = selected;
    else if (selected >= offset + rows)
        offset = selected - rows + 1;
    return clamp(offset, 0, last);
}
