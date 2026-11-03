// Which key combinations make a good shortcut. No GTK or GNOME Shell
// imports, so tests/unit.js checks it; the preferences use it.

// Keys that do nothing while typing, so they can be a shortcut alone, as in
// GNOME Settings: function keys, Print, Pause and the media keys.
const ALONE = /^(F([1-9]|[12][0-9]|3[0-5])|Print|Pause|Scroll_Lock|XF86\w+)$/;

/**
 * A shortcut is global: one made of a plain key (a letter, Backspace,
 * Enter) would take that key away from every app. It needs Ctrl, Alt or
 * Super (Shift alone still types), unless the key is one of ALONE.
 *
 * @param {string} accelerator as Gtk.accelerator_name() writes it, such as
 *   '<Super>slash', '<Shift>F5' or 'a'
 * @returns {boolean} it can be used as the shortcut
 */
export function isUsableShortcut(accelerator) {
    const modifiers = accelerator.match(/<[^>]+>/g) ?? [];
    const key = accelerator.replace(/<[^>]+>/g, '');
    if (key === '')
        return false;
    return modifiers.some(m => m.toLowerCase() !== '<shift>') || ALONE.test(key);
}
