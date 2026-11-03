// What to search for and how results are put together. No GNOME Shell
// imports, so tests/unit.js checks it and the preferences list the sources.

// Sources of results built into the bar, besides GNOME's search providers
// (Files, Settings, Calculator...), which are named by their desktop id.
export const BUILTIN_SOURCES = ['applications', 'actions', 'windows'];
// What to show before anything is typed.
export const EMPTY_QUERIES = ['frequent', 'nothing'];

// Longest text the search field takes, in characters: a pasted log of
// megabytes would otherwise be split, folded and matched against every
// window, and sent to every search provider, on the shell's only thread.
export const MAX_TEXT = 512;
// Most terms one search uses; the rest of the text is ignored.
export const MAX_TERMS = 16;

// Longest name or description of a result, in characters. They come from
// other programs (search providers over D-Bus, window titles), and a row
// shows one line of each.
export const MAX_LABEL = 512;

/**
 * Text from another program, made safe to show and to match: always a
 * string, and at most MAX_LABEL characters (never half a character).
 *
 * @param {*} value a name, description or title, whatever its type
 * @returns {string} the text
 */
export function labelText(value) {
    let text = String(value ?? '');
    if (text.length > MAX_LABEL) {
        text = text.slice(0, MAX_LABEL);
        // A surrogate pair cut in half would show as a broken glyph.
        if (/[\uD800-\uDBFF]$/.test(text))
            text = text.slice(0, -1);
    }
    return text;
}

/**
 * Splits what was typed into search terms, as GNOME's overview does, at
 * most MAX_TERMS of them from at most MAX_TEXT characters.
 *
 * @param {string} text the search field's text
 * @returns {string[]} the terms; none for blank text
 */
export function termsFor(text) {
    const trimmed = text.slice(0, MAX_TEXT).trim();
    return trimmed === '' ? [] : trimmed.split(/\s+/, MAX_TERMS);
}

/**
 * @param {string[]} a search terms
 * @param {string[]} b other search terms
 * @returns {boolean} both search for the same thing
 */
export function sameTerms(a, b) {
    return a.length === b.length && a.every((term, i) => term === b[i]);
}

/**
 * @param {string[]} previous terms of the last search
 * @param {string[]} terms terms now
 * @returns {boolean} the new search only narrows the last one, so GNOME's
 *   providers can filter their previous results instead of starting over
 */
export function isSubSearch(previous, terms) {
    if (previous.length === 0 || terms.length === 0)
        return false;
    return terms.join(' ').startsWith(previous.join(' '));
}

/**
 * @param {string} text any text
 * @returns {string} lower case without accents, so "configuracao" finds
 *   "Configuração"
 */
export function fold(text) {
    return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/**
 * How well some fields match the terms: every term must appear in one of
 * them. Lower is better: a term at the start of a word, and in the first
 * field, counts more.
 *
 * @param {string[]} terms search terms
 * @param {string[]} fields texts to search, most important first
 * @returns {number} a score, or -1 when a term is missing
 */
export function matchScore(terms, fields) {
    const folded = fields.map(f => fold(f ?? ''));
    let score = 0;
    for (const term of terms.map(fold)) {
        let best = -1;
        folded.forEach((field, i) => {
            const at = field.indexOf(term);
            if (at < 0)
                return;
            const wordStart = at === 0 || /[\s\-_./]/.test(field[at - 1]);
            const value = i * 100 + (wordStart ? 0 : 50) + Math.min(at, 49);
            if (best < 0 || value < best)
                best = value;
        });
        if (best < 0)
            return -1;
        score += best;
    }
    return score;
}

/**
 * Open windows matching the terms, best first; ties keep the order given
 * (most recently used first).
 *
 * @param {string[]} terms search terms
 * @param {{id: string, title: string, app: string}[]} windows candidates
 * @returns {string[]} ids of the matching windows
 */
export function rankWindows(terms, windows) {
    if (terms.length === 0)
        return [];
    return windows
        .map((w, order) => ({id: w.id, order, score: matchScore(terms, [w.title, w.app])}))
        .filter(w => w.score >= 0)
        .sort((a, b) => a.score - b.score || a.order - b.order)
        .map(w => w.id);
}

/**
 * Whether GNOME loads a search provider at all, as remoteSearch.js
 * loadRemoteSearchProviders() decides from org.gnome.desktop.search-providers.
 * The bar uses the overview's providers, so one GNOME leaves out finds
 * nothing here either, whatever its switch says.
 *
 * @param {string} id the provider's desktop id
 * @param {boolean} defaultEnabled not marked DefaultDisabled in its .ini
 * @param {object} gnome the search-providers settings
 * @param {boolean} gnome.disableExternal disable-external
 * @param {string[]} gnome.enabled enabled: default-disabled ones turned on
 * @param {string[]} gnome.disabled disabled: the others turned off
 * @returns {boolean} GNOME searches it
 */
export function gnomeSearches(id, defaultEnabled, {disableExternal, enabled, disabled}) {
    if (disableExternal)
        return false;
    return defaultEnabled ? !disabled.includes(id) : enabled.includes(id);
}

/**
 * @param {string} source a built-in source or a provider's desktop id
 * @param {string[]} disabled the disabled-sources setting
 * @returns {boolean} results of that source are shown
 */
export function sourceEnabled(source, disabled) {
    return !disabled.includes(source);
}

/**
 * What a result is, whatever object carries it: mergeResults() copies
 * every result on every report, so rows compare this, not the objects.
 *
 * @param {{kind: string, source: string, id: string}} result a result
 * @returns {string} the same for the same result of the same source
 */
export function resultKey({kind, source, id}) {
    return `${kind}\0${source}\0${id}`;
}

/**
 * What a screen reader says for a row: the row is a button with no label
 * of its own, so without this its accessible name would be empty.
 *
 * @param {string} name the row's first line
 * @param {string} description its second line ('' for none)
 * @param {string} source where it comes from ('' for none)
 * @returns {string} "name, description, source", leaving out what is
 *   empty and a description that only repeats the name
 */
export function spokenLabel(name, description, source) {
    return [name, description !== name ? description : '', source].filter(s => s).join(', ');
}

/**
 * @param {object[]} a results of one source
 * @param {object[]} b other results of it
 * @returns {boolean} both show the same: the same ids, names and
 *   descriptions in the same order (a window's title can change)
 */
export function sameResults(a, b) {
    return a.length === b.length && a.every((r, i) =>
        r.id === b[i].id && r.name === b[i].name && r.description === b[i].description);
}

/**
 * Puts the results of every source in one list, in the order of the
 * sources, taking at most `perSource` of each and `total` in all.
 *
 * @param {{source: string, items: object[]}[]} groups results per source,
 *   in order
 * @param {number} perSource most results of one source
 * @param {number} total most results in all
 * @returns {object[]} the items, each with its `source`
 */
export function mergeResults(groups, perSource, total) {
    const merged = [];
    for (const {source, items} of groups) {
        for (const item of items.slice(0, perSource)) {
            if (merged.length >= total)
                return merged;
            merged.push({...item, source});
        }
    }
    return merged;
}

/**
 * Moves the selection, wrapping around at the ends like rofi.
 *
 * @param {number} index selected now, -1 for none
 * @param {number} delta rows to move; Page Up and Down move a page
 * @param {number} count results
 * @param {boolean} [wrap] go from the last to the first and back; a page
 *   move stops at the ends instead
 * @returns {number} the new selection, -1 when there are no results
 */
export function moveSelection(index, delta, count, wrap = true) {
    if (count === 0)
        return -1;
    if (index < 0)
        return delta >= 0 ? 0 : count - 1;
    const next = index + delta;
    if (wrap && Math.abs(delta) === 1)
        return (next + count) % count;
    return Math.min(Math.max(next, 0), count - 1);
}
