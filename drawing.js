// Paints the highlight and the liquid drop with cairo (from Alt Tab Glide,
// with vertical drops for a list). No GNOME Shell imports: the shell paints
// the drop with it, the preferences paint the live preview, and
// tests/unit.js checks the pixels.
import Cairo from 'cairo';

/** Adds a rounded box to the path; boxes too small to draw are skipped. */
function roundedBox(cr, x, y, width, height, radius) {
    if (width <= 0 || height <= 0)
        return;
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));
    cr.newSubPath();
    cr.arc(x + width - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + width - r, y + height - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + height - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 3 * Math.PI / 2);
    cr.closePath();
}

/**
 * Adds the liquid bridge to the path: from the center of the tail to the
 * center of the head, with top and bottom edges that leave each box level
 * and curve in to the neck halfway.
 */
function bridge(cr, shape, inset) {
    const [a, b] = [shape.head, shape.tail].sort((p, q) => (p.x + p.width / 2) - (q.x + q.width / 2));
    const x0 = a.x + a.width / 2;
    const x1 = b.x + b.width / 2;
    const neck = shape.neck - 2 * inset;
    if (x1 - x0 < 1 || neck <= 0)
        return;
    const mid = (x0 + x1) / 2;
    const cy = (a.y + a.height / 2 + b.y + b.height / 2) / 2;
    const [topA, botA] = [a.y + inset, a.y + a.height - inset];
    const [topB, botB] = [b.y + inset, b.y + b.height - inset];
    const [neckTop, neckBottom] = [cy - neck / 2, cy + neck / 2];
    const qa = (mid - x0) / 2;
    const qb = (x1 - mid) / 2;
    cr.newSubPath();
    cr.moveTo(x0, topA);
    cr.curveTo(x0 + qa, topA, mid - qa, neckTop, mid, neckTop);
    cr.curveTo(mid + qb, neckTop, x1 - qb, topB, x1, topB);
    cr.lineTo(x1, botB);
    cr.curveTo(x1 - qb, botB, mid + qb, neckBottom, mid, neckBottom);
    cr.curveTo(mid - qa, neckBottom, x0 + qa, botA, x0, botA);
    cr.closePath();
}

/**
 * @param {object} box a box
 * @returns {{head: object, tail: object, neck: number}} the shape of a
 *   plain highlight on that box, as paintShape() takes it
 */
export function boxShape(box) {
    return {head: box, tail: box, neck: box.height};
}

/**
 * Moves a shape so that (x, y) becomes its origin, for painting it into a
 * surface that starts there. Vertical shapes keep their swapped coordinates.
 *
 * @param {object} shape from boxShape() or geometry.js liquidShape()
 * @param {number} x left of the surface
 * @param {number} y top of the surface
 * @returns {object} the moved shape
 */
export function offsetShape(shape, x, y) {
    const [dx, dy] = shape.vertical ? [y, x] : [x, y];
    const move = b => ({x: b.x - dx, y: b.y - dy, width: b.width, height: b.height});
    return {...shape, head: move(shape.head), tail: move(shape.tail)};
}

/**
 * Paints a highlight: a plain rounded box (see boxShape()) or a liquid drop
 * (geometry.js liquidShape()), in the coordinates of `cr`.
 *
 * @param {Cairo.Context} cr where to paint
 * @param {{head: object, tail: object, neck: number}} shape what to paint
 * @param {object} style colors are [red, green, blue, alpha], 0 to 1
 * @param {number[]} style.fill fill color; alpha 0 paints only the border
 * @param {number[]} style.border border color
 * @param {number} style.borderWidth border width in pixels, 0 for none
 * @param {number} style.radius corner radius in pixels
 * @param {number} [opacity] 0 to 1, applied to the whole highlight
 */
export function paintShape(cr, shape, style, opacity = 1) {
    const {fill, border, borderWidth, radius} = style;
    const outline = inset => {
        for (const box of [shape.head, shape.tail]) {
            roundedBox(cr, box.x + inset, box.y + inset,
                box.width - 2 * inset, box.height - 2 * inset, radius - inset);
        }
        bridge(cr, shape, inset);
    };

    cr.save();
    // A vertical drop is described with x and y swapped: swap them back.
    // Rotating a quarter turn after flipping y maps (x, y) to (y, x).
    if (shape.vertical) {
        cr.rotate(Math.PI / 2);
        cr.scale(1, -1);
    }
    // A translucent highlight is painted in a group, so its opacity applies
    // once and the overlapping parts of a drop do not look darker. Opaque,
    // it needs none: a group is one more surface to fill and blend, on
    // every frame of the liquid style.
    const group = opacity < 1;
    if (group)
        cr.pushGroup();
    // The border is the whole shape minus its inside, drawn opaque in its own
    // group and painted with its alpha.
    if (borderWidth > 0 && border[3] > 0) {
        cr.pushGroup();
        cr.setSourceRGBA(border[0], border[1], border[2], 1);
        outline(0);
        cr.fill();
        cr.setOperator(Cairo.Operator.CLEAR);
        outline(borderWidth);
        cr.fill();
        cr.popGroupToSource();
        cr.paintWithAlpha(border[3]);
    }
    if (fill[3] > 0) {
        cr.setSourceRGBA(fill[0], fill[1], fill[2], fill[3]);
        outline(borderWidth);
        cr.fill();
    }
    if (group) {
        cr.popGroupToSource();
        cr.paintWithAlpha(opacity);
    }
    cr.restore();
}
