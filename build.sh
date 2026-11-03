#!/usr/bin/env bash
# Build, install, test or pack the extension.
#   ./build.sh            compile schemas and translations in place
#   ./build.sh install    build and install to ~/.local/share/gnome-shell/extensions
#   ./build.sh stage DIR  build and copy the extension to DIR/<uuid> (used by the tests)
#   ./build.sh unit       run the unit tests (gjs only, a few seconds)
#   ./build.sh test       unit tests, then tests/smoke.sh in a headless shell (screenshots in tests/output)
#   ./build.sh bench      CPU and memory of the shell, in a headless shell
#   ./build.sh dev        install and run a nested GNOME Shell to test without logging out
#   ./build.sh prefs      install and reopen the preferences window with the new prefs.js
#   ./build.sh pack       build a zip ready for extensions.gnome.org
#   ./build.sh pot        regenerate po/search-bar.pot
set -euo pipefail
cd "$(dirname "$0")"

UUID=$(sed -n 's/.*"uuid": *"\([^"]*\)".*/\1/p' metadata.json)
DOMAIN=search-bar
# Every JavaScript file the extension needs at run time.
SOURCES=(extension.js prefs.js bar.js sources.js color.js geometry.js drawing.js layout.js query.js reveal.js preview.js shortcut.js)
# Settings written into the nested session of ./build.sh dev, as key=value
# (GVariant text). The host shell grabs Super+/ once the extension is
# installed, so the nested one opens with Super+Alt+/.
DEV_SETTINGS=("search-bar-toggle=['<Super><Alt>slash']")

build() {
    glib-compile-schemas --strict schemas
    for po in po/*.po; do
        [ -e "$po" ] || continue
        lang=$(basename "$po" .po)
        mkdir -p "locale/$lang/LC_MESSAGES"
        msgfmt --check -o "locale/$lang/LC_MESSAGES/$DOMAIN.mo" "$po"
    done
}

stage() {
    build
    dest="$1/$UUID"
    rm -rf "$dest"
    mkdir -p "$dest" locale
    cp -r metadata.json stylesheet*.css "${SOURCES[@]}" schemas locale "$dest"
}

install() {
    stage "$HOME/.local/share/gnome-shell/extensions"
    echo "Installed to $dest"
}

case "${1:-build}" in
build) build ;;
install)
    install
    echo "The running shell keeps the old code: use '$0 dev' to test, or log out and back in."
    ;;
dev)
    install
    # GNOME 49+ replaced --nested with --devkit (package mutter-devkit).
    major=$(gnome-shell --version | grep -o '[0-9]\+' | head -1)
    if [ "$major" -ge 49 ]; then mode=--devkit; else mode=--nested; fi
    missing=()
    command -v dbus-run-session >/dev/null || missing+=(dbus-daemon)
    [ "$mode" = --devkit ] && [ ! -x /usr/libexec/mutter-devkit ] && missing+=(mutter-devkit)
    if [ ${#missing[@]} -gt 0 ]; then
        echo "Missing packages: ${missing[*]} (Fedora: sudo dnf install ${missing[*]})" >&2
        exit 1
    fi
    # The nested shell gets its own dconf database: only this extension is
    # enabled, and DEV_SETTINGS are applied on top of a copy of the real
    # session's extension settings, made on every run.
    settings_path=/org/gnome/shell/extensions/$DOMAIN/
    current=$(dconf dump "$settings_path")
    profile="${XDG_CACHE_HOME:-$HOME/.cache}/$DOMAIN/dconf-profile"
    mkdir -p "$(dirname "$profile")"
    # D-Bus object paths (used by dconf for the database name) forbid hyphens.
    echo "user-db:${DOMAIN//-/_}_dev" >"$profile"
    export DCONF_PROFILE=$profile
    dconf reset -f "$settings_path"
    [ -n "$current" ] && dconf load "$settings_path" <<<"$current"
    for entry in "${DEV_SETTINGS[@]}"; do
        dconf write "${settings_path}${entry%%=*}" "${entry#*=}"
    done
    dconf write /org/gnome/shell/enabled-extensions "['$UUID']"
    dconf write /org/gnome/shell/welcome-dialog-last-shown-version "'999'"

    # The nested shell shares the machine's system bus: anything destructive
    # (power off, log out, deleting files...) must only log under DRY_RUN.
    export SEARCH_BAR_DRY_RUN=1
    export MUTTER_DEBUG_DUMMY_MODE_SPECS=${MUTTER_DEBUG_DUMMY_MODE_SPECS:-1600x900}
    echo "Starting nested GNOME Shell ($mode)."
    # Show only this extension's messages and JS errors with their stack traces.
    set +e
    dbus-run-session -- gnome-shell $mode 2>&1 |
        grep --line-buffered -E "$UUID|JS ERROR|JS WARNING|@(file|resource):"
    status=${PIPESTATUS[0]}
    set -e
    if [ "$status" -ne 0 ]; then
        echo "gnome-shell exited with status $status. Run it unfiltered to see why:" >&2
        echo "  dbus-run-session -- gnome-shell $mode" >&2
    fi
    ;;
stage)
    [ -n "${2:-}" ] || { echo "usage: $0 stage DIR" >&2; exit 1; }
    stage "$2"
    ;;
unit)
    gjs -m tests/unit.js
    ;;
test)
    # Nothing is installed in the real session; smoke.sh stages its own copy.
    gjs -m tests/unit.js
    tests/smoke.sh "${2:-tests/output}"
    ;;
bench)
    # Same throwaway session as the smoke test, measuring instead of testing.
    SEARCH_BAR_BENCH=1 tests/smoke.sh "${2:-tests/output}"
    ;;
prefs)
    install
    # The prefs process caches modules; kill it so the new prefs.js is loaded.
    pkill -f 'gjs -m /usr/share/gnome-shell/org.gnome.Shell.Extensions' || true
    gnome-extensions prefs "$UUID"
    ;;
pack)
    build
    extra=()
    for file in "${SOURCES[@]}" stylesheet-*.css; do
        [ -e "$file" ] || continue
        case $file in extension.js | prefs.js) ;; *) extra+=("--extra-source=$file") ;; esac
    done
    gnome-extensions pack --force --podir=po "${extra[@]}" .
    ;;
pot)
    xgettext --from-code=UTF-8 --language=JavaScript --keyword=_ --keyword=ngettext:1,2 \
        --package-name="$UUID" -o "po/$DOMAIN.pot" "${SOURCES[@]}"
    for po in po/*.po; do [ -e "$po" ] || continue; msgmerge -U --backup=none "$po" "po/$DOMAIN.pot"; done
    ;;
*) echo "usage: $0 [build|install|stage|unit|test|bench|dev|prefs|pack|pot]" >&2; exit 1 ;;
esac
