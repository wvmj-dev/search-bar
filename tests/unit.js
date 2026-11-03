// Unit tests for the pure modules. Run with: gjs -m tests/unit.js
// (or ./build.sh unit). No GNOME Shell needed: only modules without
// GNOME Shell imports can be loaded here, which is why the logic lives in them.
import Cairo from 'cairo';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';

import {blendOver, contrastColor, hexToRgb, parseColor, SURFACE} from '../color.js';
import {boxShape, offsetShape, paintShape} from '../drawing.js';
import {ANIMATIONS, CURVES, DEFAULT_TUNING, TUNING_KEYS, easing, liquidShape, makeTransition, motionFromSettings,
    transposeBox} from '../geometry.js';
import {barSize, customFromPlace, listHeight, MONITORS, placeBar, POSITIONS, resizeBy, ROWS_RANGE, scrollOffset,
    WIDTH_RANGE} from '../layout.js';
import {BUILTIN_SOURCES, EMPTY_QUERIES, fold, gnomeSearches, isSubSearch, matchScore, mergeResults, moveSelection, rankWindows,
    labelText, MAX_LABEL, MAX_TERMS, MAX_TEXT, resultKey, sameResults, sameTerms, sourceEnabled, spokenLabel, termsFor} from '../query.js';
import {CLOSE_SHARE, revealFrame, revealMotion, REVEALS} from '../reveal.js';
import {isUsableShortcut} from '../shortcut.js';

let failures = 0;
let count = 0;
function check(name, condition, detail = '') {
    count++;
    if (!condition) {
        failures++;
        print(`FAIL ${name} ${detail}`);
    }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
const nearBox = (a, b, e = 1e-6) => ['x', 'y', 'width', 'height'].every(k => near(a[k], b[k], e));
const samples = Array.from({length: 101}, (_, i) => i / 100);

// --- schema -----------------------------------------------------------------
// Every key has a summary, and every ranged default lies inside its range.
const dir = GLib.path_get_dirname(import.meta.url.replace('file://', ''));
const schemaFile = `${dir}/../schemas/org.gnome.shell.extensions.search-bar.gschema.xml`;
const schema = new TextDecoder().decode(GLib.file_get_contents(schemaFile)[1]);
const keys = [...schema.matchAll(/<key name="([^"]+)" type="([^"]+)">([\s\S]*?)<\/key>/g)];
const keyInfo = Object.fromEntries(keys.map(([, name, type, body]) => [name, {type, body}]));
check('the schema has keys', keys.length > 0);
for (const [, name, type, body] of keys) {
    check(`${name} has a summary`, /<summary>[^<]+<\/summary>/.test(body));
    const range = body.match(/<range min="(-?[\d.]+)" max="(-?[\d.]+)"\/>/);
    const def = body.match(/<default>([^<]*)<\/default>/)?.[1];
    if (range && (type === 'i' || type === 'd')) {
        const value = Number(def);
        check(`${name}: default ${def} inside ${range[1]}–${range[2]}`,
            value >= Number(range[1]) && value <= Number(range[2]));
    }
    const choices = [...body.matchAll(/<choice value="([^"]+)"/g)].map(m => m[1]);
    if (choices.length)
        check(`${name}: default is one of its choices`, choices.includes(def.replace(/^'|'$/g, '')));
}
const choicesOf = name => [...keyInfo[name].body.matchAll(/<choice value="([^"]+)"/g)].map(m => m[1]);
const defaultOf = name => Number(keyInfo[name].body.match(/<default>([^<]*)<\/default>/)[1]);
const rangeOf = name => keyInfo[name].body.match(/<range min="(-?[\d.]+)" max="(-?[\d.]+)"\/>/).slice(1).map(Number);
check('the selection styles match the schema', same(choicesOf('animation'), ANIMATIONS));
check('the curves match the schema', same(choicesOf('animation-curve'), CURVES));
check('the opening curves match the schema', same(choicesOf('open-curve'), CURVES));
// The bar opens without a bounce; the highlight keeps its small overshoot.
const stringDefault = name => keyInfo[name].body.match(/<default>'([^']*)'<\/default>/)[1];
check('the opening curve defaults to smooth', stringDefault('open-curve') === 'smooth');
check('the selection curve defaults to overshoot', stringDefault('animation-curve') === 'overshoot');
check('the opening styles match the schema', same(choicesOf('open-animation'), REVEALS));
check('the positions match the schema', same(choicesOf('position'), POSITIONS));
check('the monitors match the schema', same(choicesOf('monitor'), MONITORS));
check('the empty-query choices match the schema', same(choicesOf('empty-query'), EMPTY_QUERIES));
for (const [name, key] of Object.entries(TUNING_KEYS))
    check(`tuning ${name} defaults as in the schema`, keyInfo[key] && defaultOf(key) === DEFAULT_TUNING[name]);
check('resizing stays within the width range', same(rangeOf('width'), WIDTH_RANGE));
check('resizing stays within the rows range', same(rangeOf('visible-rows'), ROWS_RANGE));

// --- colors -----------------------------------------------------------------
check('accepts #rrggbb', parseColor('#3584E4') === '#3584e4');
for (const bad of ['', '3584e4', '#fff', '#3584e4ff', '#3584e4; color: red', 'red', '#12345g'])
    check(`rejects ${JSON.stringify(bad)}`, parseColor(bad) === null);
check('reads red, green and blue', same(hexToRgb('#3584e4'), [0x35, 0x84, 0xe4]));
check('dark text on a light color', contrastColor('#f6d32d') === '#000000');
check('light text on a dark color', contrastColor('#1c71d8') === '#ffffff');
{
    const bar = SURFACE;
    check('opaque, a color stays itself', blendOver('#f6d32d', 1, bar) === '#f6d32d');
    check('transparent, only the bar shows', blendOver('#f6d32d', 0, bar) === '#2e2e33');
    check('half opaque mixes halfway', blendOver('#ffffff', 0.5, [0, 0, 0]) === '#808080');
    check('a light color at 80% still takes dark text', contrastColor(blendOver('#f6d32d', 0.8, bar)) === '#000000');
    check('a light color at 20% takes light text', contrastColor(blendOver('#f6d32d', 0.2, bar)) === '#ffffff');
}

// --- transitions in a vertical list ---------------------------------------------
const row = i => ({x: 0, y: i * 52, width: 616, height: 48});
const tunings = [{}, Object.fromEntries(Object.keys(DEFAULT_TUNING).map(k => [k, 0])),
    {rebound: 100, stretchReach: 70, liquidViscosity: 100, jellyBounce: 100, jellyWobbles: 4, jellyStretch: 60,
        popSize: 80}];
for (const animation of ANIMATIONS) {
    for (const curve of CURVES) {
        for (const tuning of tunings) {
            const motion = motionFromSettings(tuning);
            const name = `${animation}/${curve}/${JSON.stringify(tuning).slice(0, 20)}`;
            const transition = makeTransition(animation, row(1), row(4), {curve, motion, vertical: true});
            const end = transition.at(1);
            check(`${name}: ends exactly on the target`, same(end.box, row(4)) && end.opacity === 1 && !end.shape);
            let ok = true;
            for (const t of samples) {
                const f = transition.at(t);
                if (f.box.width < 1 || f.box.height < 1 || f.opacity < 0 || f.opacity > 1 || !Number.isFinite(f.box.y))
                    ok = false;
            }
            check(`${name}: never inside out, opacity within 0–1`, ok);
        }
    }
}
check('first placement is instant', makeTransition('slide', null, row(2), {vertical: true}).instant);
{
    // A vertical slide moves along y only, and starts where the highlight is.
    const slide = makeTransition('slide', row(0), row(3), {vertical: true});
    check('vertical slide starts on the origin', nearBox(slide.at(0).box, row(0)));
    check('vertical slide keeps x and width', samples.every(t => near(slide.at(t).box.x, 0) &&
        near(slide.at(t).box.width, 616)));
    const mid = slide.at(0.5).box.y;
    check('vertical slide moves down', mid > 0 && mid < 3 * 52 + 20, `${mid}`);
    // The liquid drop runs vertically: the head leads, and the shape is
    // marked for drawing.js to swap back.
    const liquid = makeTransition('liquid', row(0), row(3), {vertical: true}).at(0.3);
    check('vertical liquid has a vertical shape', liquid.shape?.vertical === true);
    check('vertical liquid bounds are in real coordinates', near(liquid.box.x, liquid.shape.bounds.x) &&
        liquid.shape.bounds.height > 48 && liquid.shape.bounds.width <= 616 + 1e-6);
    const head = transposeBox(liquid.shape.head);
    const tail = transposeBox(liquid.shape.tail);
    check('vertical liquid: the head leads the tail', head.y > tail.y);
    // An interrupted fade must not flash opaque.
    const fade = makeTransition('slide', row(0), row(1), {vertical: true, fromOpacity: 0});
    check('an interrupted fade starts transparent', near(fade.at(0).opacity, 0));
}
check('transposing twice gives the box back', same(transposeBox(transposeBox(row(2))), row(2)));
{
    // Easing ends exactly on 1 and rebound grows the overshoot.
    const peak = c => Math.max(...samples.map(easing('overshoot', c)));
    check('more rebound overshoots further', peak(1) > peak(0.5) && peak(0.5) > peak(0));
    for (const curve of CURVES)
        check(`${curve} ends on exactly 1`, easing(curve)(1) === 1 && near(easing(curve)(0), 0));
    const shape = liquidShape(row(0), row(1), 0.5);
    check('liquid shape has a neck', shape.neck > 0);
}

// --- drawing ------------------------------------------------------------------
{
    // A vertical drop, painted, covers the head and the tail and leaves the
    // area beside the bridge empty.
    const tmp = GLib.dir_make_tmp('sb-unit-XXXXXX');
    const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, 120, 200);
    const cr = new Cairo.Context(surface);
    const from = {x: 10, y: 10, width: 100, height: 40};
    const to = {x: 10, y: 150, width: 100, height: 40};
    const shape = makeTransition('liquid', from, to, {vertical: true}).at(0.4).shape;
    paintShape(cr, offsetShape(shape, 0, 0), {fill: [1, 0, 0, 1], border: [0, 0, 0, 0], borderWidth: 0, radius: 8});
    cr.$dispose();
    const file = `${tmp}/drop.png`;
    surface.writeToPNG(file);
    const pixbuf = GdkPixbuf.Pixbuf.new_from_file(file);
    const pixels = pixbuf.get_pixels();
    const alpha = (x, y) => pixels[y * pixbuf.get_rowstride() + x * 4 + 3];
    const head = transposeBox(shape.head);
    const tail = transposeBox(shape.tail);
    check('drop: the head is painted', alpha(60, Math.round(head.y + head.height / 2)) > 200);
    check('drop: the tail is painted', alpha(60, Math.round(tail.y + tail.height / 2)) > 200);
    check('drop: the bridge runs down the middle', alpha(60, Math.round((head.y + tail.y + tail.height) / 2)) > 200);
    check('drop: the corners stay empty', alpha(0, 199) === 0 && alpha(119, 0) === 0);
    GLib.unlink(file);

    // A plain box at full and half opacity: the fill and the border keep
    // their colors, and half opacity halves both.
    const paintBox = opacity => {
        const box = new Cairo.ImageSurface(Cairo.Format.ARGB32, 60, 40);
        const ctx = new Cairo.Context(box);
        paintShape(ctx, boxShape({x: 0, y: 0, width: 60, height: 40}),
            {fill: [1, 0, 0, 1], border: [1, 1, 1, 0.6], borderWidth: 4, radius: 8}, opacity);
        ctx.$dispose();
        const path = `${tmp}/box-${opacity}.png`;
        box.writeToPNG(path);
        const image = GdkPixbuf.Pixbuf.new_from_file(path);
        GLib.unlink(path);
        const data = image.get_pixels();
        // Unpremultiplied red, green, blue and alpha.
        return (x, y) => [0, 1, 2, 3].map(i => data[y * image.get_rowstride() + x * 4 + i]);
    };
    const opaque = paintBox(1);
    const half = paintBox(0.5);
    check('opacity 1: the fill is solid red', same(opaque(30, 20), [255, 0, 0, 255]));
    check('opacity 1: the border is white at its alpha', Math.abs(opaque(30, 1)[3] - 153) <= 2 &&
        opaque(30, 1).slice(0, 3).every(c => c >= 250));
    check('opacity 1: outside the corner stays empty', opaque(0, 0)[3] === 0);
    check('opacity 0.5: the fill is half transparent red', Math.abs(half(30, 20)[3] - 128) <= 2 &&
        half(30, 20)[0] >= 250 && half(30, 20)[1] <= 5);
    check('opacity 0.5: the border is halved too', Math.abs(half(30, 1)[3] - 77) <= 2);
    GLib.rmdir(tmp);

    const moved = offsetShape({...boxShape({x: 30, y: 50, width: 10, height: 20}), vertical: true}, 5, 7);
    check('offsetShape swaps the offset of vertical shapes', moved.head.x === 30 - 7 && moved.head.y === 50 - 5);
}

// --- layout -------------------------------------------------------------------
{
    const config = {width: 640, rows: 8, iconSize: 32};
    const size = barSize(config);
    check('a row holds the icon and its padding', size.rowHeight === 48);
    check('the bar is as tall as all its rows', size.height === Math.round(size.top + listHeight(8, 48, 4) + 12));
    const hidpi = barSize(config, 2);
    check('sizes double on a HiDPI screen', hidpi.width === 1280 && hidpi.rowHeight === 96 &&
        Math.abs(hidpi.height - 2 * size.height) <= 1);
    check('an empty list has no height', listHeight(0, 48, 4) === 0);
    check('text taller than the icon makes the row taller', barSize({...config, textHeight: 44}).rowHeight === 60);
    check('text shorter than the icon leaves the row as it was', barSize({...config, textHeight: 20}).rowHeight === 48);
    check('the text height is already physical on HiDPI',
        barSize({...config, textHeight: 60}, 2).rowHeight === 96 && barSize({...config, textHeight: 88}, 2).rowHeight === 120);
    check('resizing steps by the taller row', resizeBy({...config, textHeight: 44}, 0, 64 * 2).rows === 10);

    const area = {x: 100, y: 32, width: 1280, height: 768};
    const center = placeBar(area, size, 'center');
    check('center: centered across', center.x === 100 + (1280 - 640) / 2);
    check('center: centered down for the full bar', center.y === Math.round(32 + (768 - size.height) / 2));
    check('top: above the center', placeBar(area, size, 'top').y < center.y);
    check('bottom: below the center', placeBar(area, size, 'bottom').y > center.y);
    for (const [x, y] of [[0, 0], [100, 100], [-50, 300], [37.5, 62.25]]) {
        const p = placeBar(area, size, 'custom', {x, y});
        check(`custom ${x},${y}: inside the area`, p.x >= area.x && p.y >= area.y &&
            p.x + size.width <= area.x + area.width && p.y + size.height <= area.y + area.height);
    }
    // Saving where it was dragged and placing it again lands on the pixel.
    let roundTrip = true;
    for (const [x, y] of [[100, 32], [740, 200], [455, 61], [321, 99]]) {
        const custom = customFromPlace(area, size, x, y);
        const p = placeBar(area, size, 'custom', custom);
        if (Math.abs(p.x - x) > 1 || Math.abs(p.y - y) > 1)
            roundTrip = false;
    }
    check('a dragged place is saved and restored to the pixel', roundTrip);
    const tiny = {x: 0, y: 0, width: 300, height: 200};
    check('a bar larger than the monitor sits at its corner', same(placeBar(tiny, size, 'bottom'), {x: 0, y: 0}));
    check('customFromPlace with no free space is the middle', same(customFromPlace(tiny, size, 0, 0), {x: 50, y: 50}));

    check('resizing wider', resizeBy(config, 100, 0).width === 740);
    check('resizing narrower stops at the minimum', resizeBy(config, -1000, 0).width === WIDTH_RANGE[0]);
    check('resizing stops at the monitor', resizeBy(config, 5000, 0, 1, 900).width === 900);
    check('resizing snaps to whole rows', resizeBy(config, 0, 52 * 2 + 10).rows === 10 &&
        resizeBy(config, 0, 20).rows === 8);
    check('resizing on HiDPI moves in physical pixels', resizeBy(config, 200, 0, 2).width === 740);
    check('rows stay within their range', resizeBy(config, 0, -5000).rows === 1 && resizeBy(config, 0, 5000).rows === 20);

    check('no scrolling while the selection is visible', scrollOffset(30, 8, 5, 0) === 0);
    check('scrolls down to show the selection at the bottom', scrollOffset(30, 8, 8, 0) === 1);
    check('scrolls up to the selection', scrollOffset(30, 8, 2, 5) === 2);
    check('never scrolls past the end', scrollOffset(10, 8, 9, 7) === 2);
    check('a short list never scrolls', scrollOffset(3, 8, 2, 4) === 0);
}

// --- search -------------------------------------------------------------------
check('terms split on spaces', same(termsFor('  text   editor '), ['text', 'editor']));
check('blank text has no terms', same(termsFor('   '), []));
{
    // A pasted log: megabytes of text, hundreds of thousands of words.
    const huge = 'word '.repeat(1_000_000);
    const start = GLib.get_monotonic_time();
    const terms = termsFor(huge);
    const elapsed = (GLib.get_monotonic_time() - start) / 1000;
    check(`huge text gives at most ${MAX_TERMS} terms`, terms.length === MAX_TERMS);
    check('huge text is split in well under a millisecond or so', elapsed < 20, `${elapsed} ms`);
    check(`only the first ${MAX_TEXT} characters count`, termsFor(`${'x'.repeat(MAX_TEXT)} late`).length === 1);
    check('a long single word is cut, not dropped', termsFor('y'.repeat(5000))[0].length === MAX_TEXT);
}
check('labels are always strings', labelText(42) === '42' && labelText(null) === '' && labelText(undefined) === '' &&
    labelText('Files') === 'Files');
check(`labels are cut at ${MAX_LABEL} characters`, labelText('L'.repeat(100000)).length === MAX_LABEL);
check('a label is never cut inside a character', labelText(`${'a'.repeat(MAX_LABEL - 1)}😀`) === 'a'.repeat(MAX_LABEL - 1));
check('the same terms are the same search', sameTerms(termsFor(' fire  fox'), ['fire', 'fox']) &&
    sameTerms([], []));
check('different terms are another search', !sameTerms(['fir'], ['fire']) && !sameTerms(['a'], ['a', 'b']) &&
    !sameTerms([], ['a']));
check('typing more narrows the search', isSubSearch(['fir'], ['fire']) && isSubSearch(['a'], ['a', 'b']));
check('changing the text starts over', !isSubSearch(['fire'], ['fir']) && !isSubSearch([], ['a']));
check('folding drops accents and case', fold('Configuração') === 'configuracao');
check('every term must match', matchScore(['term', 'zzz'], ['Terminal']) === -1);
check('a word start beats the middle', matchScore(['edit'], ['Text Editor']) < matchScore(['dit'], ['Text Editor']));
check('the first field counts more', matchScore(['files'], ['Files', '']) < matchScore(['files'], ['x', 'Files']));
check('accents do not matter', matchScore(['configuracoes'], ['Configurações']) >= 0 &&
    matchScore(['ÉDIT'], ['Text Editor']) >= 0);
{
    const windows = [
        {id: '1', title: 'README.md — Editor', app: 'Text Editor'},
        {id: '2', title: 'Downloads', app: 'Files'},
        {id: '3', title: 'notes', app: 'Text Editor'},
    ];
    check('windows match by title or app', same(rankWindows(['editor'], windows), ['1', '3']));
    check('windows match every term', same(rankWindows(['text', 'notes'], windows), ['3']));
    check('no terms, no windows', same(rankWindows([], windows), []));
}
{
    const gnome = {disableExternal: false, enabled: ['b.desktop'], disabled: ['a.desktop']};
    check('GNOME searches a provider nobody turned off', gnomeSearches('c.desktop', true, gnome));
    check('GNOME skips a provider turned off in Settings', !gnomeSearches('a.desktop', true, gnome));
    check('GNOME skips a default-disabled provider unless turned on',
        !gnomeSearches('c.desktop', false, gnome) && gnomeSearches('b.desktop', false, gnome));
    check('"disable external" turns every provider off', !gnomeSearches('c.desktop', true, {...gnome, disableExternal: true}) &&
        !gnomeSearches('b.desktop', false, {...gnome, disableExternal: true}));
}
check('built-in sources are known', same(BUILTIN_SOURCES, ['applications', 'actions', 'windows']));
check('disabled sources are off', !sourceEnabled('windows', ['windows']) && sourceEnabled('apps', ['windows']));
{
    const groups = [
        {source: 'applications', items: [{id: 'a'}, {id: 'b'}, {id: 'c'}]},
        {source: 'windows', items: []},
        {source: 'files', items: [{id: 'x'}, {id: 'y'}]},
    ];
    const merged = mergeResults(groups, 2, 10);
    check('merging keeps the sources in order, capped per source',
        same(merged.map(r => r.id), ['a', 'b', 'x', 'y']) && merged[2].source === 'files');
    check('merging stops at the total', mergeResults(groups, 5, 4).length === 4);
    // Every report copies the results; rows must still see the same ones.
    const again = mergeResults(groups, 2, 10);
    check('a result keeps its key across reports', again[0] !== merged[0] &&
        again.every((r, i) => resultKey(r) === resultKey(merged[i])));
    check('the same id from two sources is two results',
        resultKey({kind: 'remote', source: 'a', id: '1'}) !== resultKey({kind: 'remote', source: 'b', id: '1'}));
    const items = [{id: '1', name: 'Notes', description: 'Editor'}, {id: '2', name: 'Files', description: ''}];
    check('the same results are the same', sameResults(items, items.map(r => ({...r}))) && sameResults([], []));
    check('a row is spoken as name, description, source',
        spokenLabel('Editor', 'Text editor', 'Apps') === 'Editor, Text editor, Apps');
    check('a spoken row leaves out what is empty or repeats the name',
        spokenLabel('Editor', '', 'Apps') === 'Editor, Apps' && spokenLabel('Editor', 'Editor', '') === 'Editor');
    check('a renamed window is a change', !sameResults(items, [{...items[0], name: 'Notes 2'}, items[1]]));
    check('another order is a change', !sameResults(items, [items[1], items[0]]) && !sameResults(items, [items[0]]));
}
check('down wraps from the last to the first', moveSelection(4, 1, 5) === 0);
check('up wraps from the first to the last', moveSelection(0, -1, 5) === 4);
check('a page stops at the end', moveSelection(3, 8, 5) === 4 && moveSelection(2, -8, 5) === 0);
check('no results, no selection', moveSelection(0, 1, 0) === -1);
check('the wheel does not wrap', moveSelection(4, 1, 5, false) === 4);

// --- shortcut -----------------------------------------------------------------
for (const good of ['<Super>slash', '<Control><Alt>t', '<Alt>space', '<Shift><Super>s', 'F1', 'F12', '<Shift>F5', 'Print',
    'XF86Search'])
    check(`${good} is a usable shortcut`, isUsableShortcut(good));
for (const bad of ['a', 'slash', 'BackSpace', 'Return', 'space', '<Shift>a', '<Shift>slash', 'Home', '', '<Super>'])
    check(`${JSON.stringify(bad)} is not a usable shortcut`, !isUsableShortcut(bad));

// --- reveal -------------------------------------------------------------------
for (const style of REVEALS) {
    const shown = revealFrame(style, 1);
    check(`${style}: fully shown at 1`, shown.opacity === 1 && shown.scaleX === 1 && shown.scaleY === 1 &&
        shown.dy === 0);
    check(`${style}: invisible at 0`, revealFrame(style, 0).opacity === 0);
    check(`${style}: never a zero scale`, samples.every(v => revealFrame(style, v - 0.2).scaleY > 0));
}
check('zoom starts at 90% at 50', near(revealFrame('zoom', 0).scaleX, 0.9));
check('more amount zooms from smaller', revealFrame('zoom', 0, 100).scaleX < revealFrame('zoom', 0, 0).scaleX);
check('slide comes from above, 48 px at 50', near(revealFrame('slide', 0).dy, -48));
check('unfold opens from the top edge', revealFrame('unfold', 0.5).pivotY === 0);
{
    const open = revealMotion(0, true, 'overshoot');
    check('opening ends exactly open', open(1) === 1 && near(open(0), 0));
    check('opening overshoots with overshoot', samples.some(t => open(t) > 1));
    const reopen = revealMotion(0.4, true, 'smooth');
    check('reopening starts where it was', near(reopen(0), 0.4));
    const close = revealMotion(0.7, false, 'overshoot');
    check('closing starts where it was and ends closed', near(close(0), 0.7) && close(1) === 0);
    check('closing never rebounds', samples.every((t, i) => i === 0 || close(t) <= close(samples[i - 1]) + 1e-9));
    check('closing is quicker than opening', CLOSE_SHARE < 1);
}

print(`${count - failures}/${count} checks passed`);
if (failures > 0)
    imports.system.exit(1);
