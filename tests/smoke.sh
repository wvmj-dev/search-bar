#!/usr/bin/env bash
# Smoke test: runs the extension in a throwaway headless GNOME Shell with a
# few test windows, drives it through scenarios, checks what it does, saves
# screenshots and fails on any JavaScript error. Nothing touches the real
# session: the shell gets its own D-Bus session bus, dconf database and
# XDG_DATA_HOME, and no display.
#
#   tests/smoke.sh <output dir>     (normally run through ./build.sh test)
#   SEARCH_BAR_BENCH=1 tests/smoke.sh  (./build.sh bench: measures instead)
#
# The extension is staged from the working tree into a temporary directory,
# so the copy installed in ~/.local is neither used nor changed.
set -euo pipefail

if [ -z "${SEARCH_BAR_SMOKE_INNER:-}" ]; then
    root=$(cd "$(dirname "$0")/.." && pwd)
    out=$(mkdir -p "${1:-$root/tests/output}" && cd "${1:-$root/tests/output}" && pwd)
    uuid=$(sed -n 's/.*"uuid": *"\([^"]*\)".*/\1/p' "$root/metadata.json")
    work=$(mktemp -d)
    # A dconf database per run, so smoke tests running at the same time (two
    # projects, two terminals) cannot overwrite each other's settings. dconf
    # keeps it as a file in ~/.config/dconf; it is deleted at the end.
    db="search_bar_test_$$"
    dbfile="${XDG_CONFIG_HOME:-$HOME/.config}/dconf/$db"
    trap 'rm -rf "$work"; rm -f "${dbfile:?}"' EXIT

    ext="$work/share/gnome-shell/extensions"
    mkdir -p "$ext" "$work/share/applications"
    "$root/build.sh" stage "$ext"
    cp -r "$root/tests/devtools" "$ext/search-bar-devtools@local"
    # One GTK script plays several apps, so there are real windows to test with.
    while read -r id name icon; do
        sed -e "s|@APP@|$root/tests/app/testapp.js|" -e "s|@ID@|$id|" \
            -e "s|@NAME@|$name|g" -e "s|@ICON@|$icon|" \
            "$root/tests/app/template.desktop" >"$work/share/applications/$id.desktop"
    done <<'EOF'
org.search_bar.Files Files system-file-manager
org.search_bar.Editor Editor accessories-text-editor
EOF
    # The screenshots go into the README: hide every app installed on this
    # machine that is not part of GNOME, so they show GNOME's own apps and
    # the test apps, never what the developer has installed. A .desktop
    # file in XDG_DATA_HOME takes the place of the one with the same id in
    # the other data directories (including Flatpak's exports), for the
    # shell and for the preferences. It must be a complete entry: GLib skips
    # one without a Name and finds the real app instead. NoDisplay hides it
    # from the preferences' list of search providers too.
    IFS=: read -ra data_dirs <<<"${XDG_DATA_DIRS:-/usr/local/share:/usr/share}"
    for dir in "${data_dirs[@]}" "$HOME/.local/share"; do
        for file in "$dir"/applications/*.desktop; do
            [ -e "$file" ] || continue
            id=$(basename "$file")
            case $id in org.gnome.* | org.search_bar.*) continue ;; esac
            [ -e "$work/share/applications/$id" ] ||
                printf '[Desktop Entry]\nType=Application\nName=Hidden\nExec=false\nNoDisplay=true\nHidden=true\n' \
                    >"$work/share/applications/$id"
        done
    done
    # A search provider whose name is not valid markup, for the Sources page
    # of the preferences. GNOME lists providers of shown apps only; nothing
    # the tests search for finds this one.
    mkdir -p "$work/share/gnome-shell/search-providers"
    printf '[Desktop Entry]\nType=Application\nName=Ink & <b>Lab\nIcon=text-x-generic\nExec=ls\n' \
        >"$work/share/applications/org.search_bar.Markup.desktop"
    printf '[Shell Search Provider]\nDesktopId=org.search_bar.Markup.desktop\nBusName=org.search_bar.Markup\nObjectPath=/org/search_bar/Markup\nVersion=2\n' \
        >"$work/share/gnome-shell/search-providers/org.search_bar.Markup.ini"
    rm -f "$out"/*.png "$out"/*.log

    echo "user-db:$db" >"$work/dconf-profile"
    export DCONF_PROFILE="$work/dconf-profile"
    # Wipes the whole test database, so refuse unless it really is the test one.
    reset_test_db() {
        [ "$DCONF_PROFILE" = "$work/dconf-profile" ] &&
            grep -qx "user-db:$db" "$DCONF_PROFILE" || {
            echo "refusing to reset dconf: unexpected profile"
            exit 1
        }
        dconf reset -f /
    }
    reset_test_db
    dconf write /org/gnome/shell/enabled-extensions "['$uuid', 'search-bar-devtools@local']"
    dconf write /org/gnome/shell/welcome-dialog-last-shown-version "'999'"
    # GNOME's search providers would start their apps on the private bus;
    # the tests use the overview's own apps provider and open windows.
    dconf write /org/gnome/desktop/search-providers/disable-external true

    export SEARCH_BAR_SMOKE_INNER=1 SEARCH_BAR_UUID=$uuid SEARCH_BAR_OUT=$out SEARCH_BAR_WORK=$work
    status=0
    # Services on the private bus are chatty; keep their output in a file.
    dbus-run-session -- "$0" 2>"$out/session.log" || status=$?
    reset_test_db
    exit $status
fi

# --- Inside the private session bus ---------------------------------------
P=/org/gnome/shell/extensions/search-bar/
log="$SEARCH_BAR_OUT/shell.log"

XDG_DATA_HOME="$SEARCH_BAR_WORK/share" SEARCH_BAR_DRY_RUN=1 \
    gnome-shell --headless --virtual-monitor 1280x800 >"$log" 2>&1 &
shell=$!
trap 'kill $shell 2>/dev/null; wait $shell 2>/dev/null' EXIT

js() {
    local reply
    reply=$(gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell \
        --method org.gnome.Shell.Eval "$1" 2>&1) || { echo "$reply"; return 1; }
    [[ $reply == "(true,"* ]] || { echo "Eval failed: $1 -> $reply"; return 1; }
    echo "$reply"
}
# Runs an expression for its side effects; any failure stops the test.
# Wrap code that declares variables in an IIFE: every Eval shares one scope.
run() {
    local reply
    reply=$(js "$1") || { echo "$reply"; exit 1; }
}
# True only when the expression evaluates to true. Eval replies
# "(true, '<result>')", where the first true just means the call worked.
is_true() { [[ $(js "$1" 2>/dev/null) == "(true, 'true')" ]]; }
expect() { is_true "$1" || { echo "FAILED: $2"; js "$1" || true; exit 1; }; }
shot() {
    gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell/Screenshot \
        --method org.gnome.Shell.Screenshot.Screenshot false false "$SEARCH_BAR_OUT/$1.png" >/dev/null
    echo "  screenshot: $SEARCH_BAR_OUT/$1.png"
}
pause() { sleep "${1:-0.6}"; }

EXT="Main.extensionManager.lookup('$SEARCH_BAR_UUID')"
STATE="$EXT.stateObj"
APPS="imports.gi.Shell.AppSystem.get_default()"
TEST_WINDOWS="global.display.list_all_windows().filter(w =>
    imports.gi.Shell.WindowTracker.get_default().get_window_app(w)?.get_id().startsWith('org.search_bar'))"

for _ in $(seq 1 60); do
    is_true "$EXT?.state === 1 && global.context.unsafe_mode" && break
    sleep 0.5
done
expect "$EXT.state === 1" "extension did not start"
run "Main.overview.hide(); 1"
pause 1

echo "0. test windows"
for id in Files Editor; do
    run "$APPS.lookup_app('org.search_bar.$id.desktop').activate(); 1"
    pause 0.8
done
for _ in $(seq 1 40); do is_true "$TEST_WINDOWS.length === 2" && break; sleep 0.25; done
expect "$TEST_WINDOWS.length === 2" "the test apps did not open their windows"
run "$TEST_WINDOWS.forEach((w, i) => w.move_frame(true, 80 + i * 220, 90 + i * 120)); 1"
pause 1

if [ -n "${SEARCH_BAR_BENCH:-}" ]; then
    # --- ./build.sh bench: CPU and memory of the shell, not a test ----------
    hz=$(getconf CLK_TCK)
    ticks() { awk '{print $14 + $15}' "/proc/$shell/stat"; }
    rss() { awk '/VmRSS/ {print $2}' "/proc/$shell/status"; }
    # CPU of the shell over a few seconds of $2 (a shell function).
    measure() {
        local start end t0 t1
        start=$(ticks)
        t0=$(date +%s.%N)
        "$2"
        end=$(ticks)
        t1=$(date +%s.%N)
        awk -v a="$start" -v b="$end" -v t0="$t0" -v t1="$t1" -v hz="$hz" -v l="$1" \
            'BEGIN { printf "  %-40s %5.1f%% of a core\n", l, 100 * (b - a) / hz / (t1 - t0) }'
    }
    idle() { sleep 10; }
    B="$STATE._bar"
    # Opens the bar, searches, moves the selection 40 times at a human
    # pace (0.25 s), and closes it.
    interact() {
        run "$STATE.toggle(); 1"; sleep 0.5
        run "$B._entry.text = 'e'; 1"; sleep 0.5
        for i in $(seq 1 40); do run "$B._select(($i * 3) % Math.max($B._results.length, 1)); 1"; sleep 0.25; done
        run "$B.close(); 1"; sleep 0.5
    }
    # The same Evals at the same pace, doing nothing: what driving the
    # shell over D-Bus costs by itself, in every row above it.
    evals_only() {
        run "1"; sleep 0.5
        run "1"; sleep 0.5
        for _ in $(seq 1 40); do run "1"; sleep 0.25; done
        run "1"; sleep 0.5
    }
    # The same with the selection jumping instantly, to isolate the
    # highlight's animation.
    interact_still() {
        run "$SET_.set_string('animation', 'none'); 1"
        interact
        run "$SET_.reset('animation'); 1"
    }
    SET_="$STATE._settings"
    echo "CPU"
    run "Main.extensionManager.disableExtension('$SEARCH_BAR_UUID'); 1"; pause 1
    measure "idle, extension disabled" idle
    run "Main.extensionManager.enableExtension('$SEARCH_BAR_UUID'); 1"; pause 1
    measure "idle, extension enabled" idle
    measure "the same Evals, doing nothing" evals_only
    measure "searching, 40 moves (slide)" interact
    run "$SET_.set_string('animation', 'liquid'); 1"
    measure "searching, 40 moves (liquid, cairo)" interact
    run "$SET_.reset('animation'); 1"
    measure "searching, 40 moves (no animation)" interact_still

    echo "Memory (resident size of gnome-shell, garbage collected)"
    # A leak grows in every round; caches and the JavaScript heap settling in
    # grow only at first. Every disable() must leave nothing behind.
    for round in 1 2 3 4; do
        run "imports.system.gc(); 1"; pause 1
        before=$(rss)
        for _ in $(seq 1 30); do
            run "$STATE.toggle(); $B._entry.text = 'e'; 1"; sleep 0.3
            run "$B.destroy(); $STATE._bar = null; 1"
        done
        run "imports.system.gc(); 1"; pause 2
        after=$(rss)
        printf "  round %d, 30 open/search/close:    %4d MiB -> %4d MiB  (%+d KiB)\n" \
            "$round" $((before / 1024)) $((after / 1024)) $((after - before))
    done
    for round in 1 2 3 4; do
        run "imports.system.gc(); 1"; pause 1
        before=$(rss)
        for _ in $(seq 1 50); do
            run "Main.extensionManager.disableExtension('$SEARCH_BAR_UUID'); Main.extensionManager.enableExtension('$SEARCH_BAR_UUID'); 1"
        done
        run "imports.system.gc(); 1"; pause 2
        after=$(rss)
        printf "  round %d, 50 disable/enable cycles: %4d MiB -> %4d MiB  (%+d KiB)\n" \
            "$round" $((before / 1024)) $((after / 1024)) $((after - before))
    done
    exit 0
fi

BAR="$STATE._bar"
SET="$STATE._settings"
# Real input: a virtual keyboard and pointer, as a user would press keys and drag.
run "(() => {
    const seat = imports.gi.Clutter.get_default_backend().get_default_seat();
    global._sbKeys = seat.create_virtual_device(imports.gi.Clutter.InputDeviceType.KEYBOARD_DEVICE);
    global._sbPointer = seat.create_virtual_device(imports.gi.Clutter.InputDeviceType.POINTER_DEVICE);
    return 1;
})()"
# Super+/ on the virtual keyboard, through GNOME's keybindings.
press_shortcut() {
    run "(() => {
        const C = imports.gi.Clutter, t = imports.gi.GLib.get_monotonic_time();
        global._sbKeys.notify_keyval(t, C.KEY_Super_L, C.KeyState.PRESSED);
        global._sbKeys.notify_keyval(t + 100, C.KEY_slash, C.KeyState.PRESSED);
        global._sbKeys.notify_keyval(t + 200, C.KEY_slash, C.KeyState.RELEASED);
        global._sbKeys.notify_keyval(t + 300, C.KEY_Super_L, C.KeyState.RELEASED);
        return 1;
    })()"
}
key() {
    run "(() => {
        const C = imports.gi.Clutter, t = imports.gi.GLib.get_monotonic_time();
        global._sbKeys.notify_keyval(t, C.KEY_$1, C.KeyState.PRESSED);
        global._sbKeys.notify_keyval(t + 1000, C.KEY_$1, C.KeyState.RELEASED);
        return 1;
    })()"
    sleep 0.05
}
type_text() {
    local i
    for ((i = 0; i < ${#1}; i++)); do key "${1:i:1}"; done
}
# The virtual pointer sometimes takes the first move after a pause with one
# axis at 0; moving until the shell reports the place avoids it.
pointer_to() {
    local i
    for i in 1 2 3 4 5; do
        run "global._sbPointer.notify_absolute_motion(imports.gi.GLib.get_monotonic_time(), $1, $2); 1"
        sleep 0.05
        is_true "global.get_pointer()[0] === Math.round($1) && global.get_pointer()[1] === Math.round($2)" && return 0
    done
    expect "false" "the pointer did not reach $1,$2"
}
button() {
    run "global._sbPointer.notify_button(imports.gi.GLib.get_monotonic_time(), imports.gi.Clutter.BUTTON_PRIMARY,
        imports.gi.Clutter.ButtonState.$1); 1"
    sleep 0.05
}
wait_for() {
    local i
    for i in $(seq 1 40); do is_true "$1" && return 0; sleep 0.1; done
    expect "$1" "$2"
}
set_key() { dconf write "$P$1" "$2"; wait_for "$SET.get_value('$1').print(true) === \"$2\"" "setting $1 not seen"; }
open_bar() {
    run "$STATE.toggle(); 1"
    wait_for "$BAR?.isOpen && $BAR._reveal === 1 && !$BAR._revealTimeline" "the bar did not open"
}
close_now() { run "$BAR?.destroy(); $STATE._bar = null; 1"; }
search() {
    run "$BAR._entry.text = '$1'; 1"
    wait_for "$BAR._searcher.terms.join(' ') === '$1' && !$BAR._searching" "search for '$1' did not finish"
    pause 0.3
}
# The highlight lies exactly on the selected row, on screen.
HIGHLIGHT_ON_ROW="(() => {
    const b = $BAR, row = b._rows[b._selected - b._offset];
    const a = row.get_transformed_extents(), h = b._highlight.get_transformed_extents();
    return !b._timeline && b._highlight.opacity === 255 &&
        ['x', 'y', 'width', 'height'].every(k => Math.abs(a.get_top_left().x - h.get_top_left().x) <= 1.5 &&
            Math.abs(a.get_top_left().y - h.get_top_left().y) <= 1.5 &&
            Math.abs(a.get_width() - h.get_width()) <= 1.5 && Math.abs(a.get_height() - h.get_height()) <= 1.5);
})()"
# Every row showing a description holds both lines inside it, close together.
ROWS_FIT="(() => {
    const rows = $BAR._rows.filter(r => r.visible && r._sb.description.visible);
    return rows.length > 0 && rows.every(r => {
        const box = r.get_transformed_extents(), n = r._sb.name.get_transformed_extents();
        const d = r._sb.description.get_transformed_extents();
        const top = box.get_top_left().y, bottom = top + box.get_height();
        const nTop = n.get_top_left().y, nBottom = nTop + n.get_height();
        const dTop = d.get_top_left().y, dBottom = dTop + d.get_height();
        return nTop >= top + 1 && dBottom <= bottom - 1 && dTop - nBottom <= 4;
    });
})()"
UI_GONE="!Main.layoutManager.uiGroup.get_children().some(a => a.get_children?.().some(c => c.style_class === 'sb-panel'))"

echo "1. enabled: only a keybinding while closed"
expect "Main.wm._allowedKeybindings['search-bar-toggle'] > 0" "the shortcut is not registered"
expect "$BAR === null && $UI_GONE" "something built before the bar was opened"

echo "2. the shortcut opens the bar, centered, with the keyboard in the field"
press_shortcut
wait_for "$BAR?.isOpen && $BAR._reveal === 1" "Super+/ did not open the bar"
expect "global.stage.key_focus === $BAR._entry.clutter_text" "the search field does not have the keyboard"
expect "Main.modalCount === 1" "the bar is not modal"
expect "$BAR._backdrop === null && !$BAR._root.get_children().some(c => c.style_class === 'sb-backdrop')" \
    "a backdrop exists although the screen is not darkened"
expect "(() => {
    const p = $BAR._panel, area = Main.layoutManager.getWorkAreaForMonitor(0);
    return p.width === 640 && Math.abs(p.x + p.width / 2 - (area.x + area.width / 2)) <= 1;
})()" "the bar is not 640 px wide and centered"
shot 01-open

echo "3. typing searches apps and windows; the highlight sits on the first result"
type_text edi
wait_for "$BAR._searcher.terms.join(' ') === 'edi' && !$BAR._searching" "typing did not search"
pause 0.4
expect "$BAR._results.some(r => r.kind === 'app' && r.id === 'org.search_bar.Editor.desktop')" "the Editor app was not found"
expect "$BAR._results.some(r => r.kind === 'window' && r.name === 'Editor')" "the Editor window was not found"
# The Editor window is titled like its app: its row must still differ.
expect "(() => {
    const i = $BAR._results.findIndex(r => r.kind === 'window' && r.name === 'Editor');
    const w = $BAR._results[i], row = $BAR._rows[i - $BAR._offset]._sb;
    return w.description !== '' && w.description !== w.name && row.description.visible &&
        row.description.text === w.description;
})()" "the Editor window's row looks like the Editor app's"
expect "$BAR._selected === 0 && $HIGHLIGHT_ON_ROW" "the highlight is not on the first result"
expect "$BAR._count.text === '1/' + $BAR._results.length" "the counter is wrong"
expect "$BAR._rows[0].has_style_pseudo_class('selected') && Math.abs($BAR._rows[0]._sb.icon.scale_x - 1.1) < 0.01" \
    "the selected row is not marked or its icon did not grow"
expect "$ROWS_FIT" "a result's name and description do not fit in its row, or sit apart"
shot 02-results

# Where results come from shows once per source: on the first row of
# each run of results from the same source.
expect "(() => {
    const b = $BAR, rows = b._rows.filter(r => r.visible);
    const first = rows.map((r, i) => i === 0 || b._results[b._offset + i - 1].source !== b._results[b._offset + i].source);
    return first.includes(false) && rows.every((r, i) => r._sb.source.visible === first[i]);
})()" "the source label is not shown once per source"
echo "3b. typing again puts the selection back on the first result"
key Down; key Down
wait_for "$BAR._selected === 2" "Down did not move the selection"
key BackSpace
wait_for "$BAR._searcher.terms.join(' ') === 'ed' && !$BAR._searching" "deleting a letter did not search"
expect "$BAR._selected === 0" "the selection did not go back to the top for new text"
key i
wait_for "$BAR._searcher.terms.join(' ') === 'edi' && !$BAR._searching" "typing did not search"
pause 0.3

echo "3c. pasting megabytes of words is cut to a short text and a few terms"
# Built inside the shell, so only the paste is timed, not D-Bus.
run "(() => {
    const GLib = imports.gi.GLib, text = 'word '.repeat(600000);
    const start = GLib.get_monotonic_time();
    $BAR._entry.text = text;
    global._sbPasteMs = (GLib.get_monotonic_time() - start) / 1000;
    return 1;
})()"
expect "$BAR._entry.text.length <= 512" "the field took the whole pasted text"
wait_for "$BAR._searcher.terms.length > 0 && $BAR._searcher.terms[0] === 'word' && !$BAR._searching" \
    "the pasted text was not searched"
expect "$BAR._searcher.terms.length <= 16" "the pasted text gave too many terms"
expect "global._sbPasteMs < 250" "pasting took too long"
# Still responsive: the field and the list react at once.
run "$BAR._entry.text = 'edi'; 1"
wait_for "$BAR._searcher.terms.join(' ') === 'edi' && !$BAR._searching && $BAR._results.length > 1" \
    "the bar did not search again after the paste"
key Down
wait_for "$BAR._selected === 1" "the bar stopped responding after the paste"
key Up
wait_for "$BAR._selected === 0 && $HIGHLIGHT_ON_ROW" "the bar stopped responding after the paste"

echo "3d. screen readers: rows have names, the selected one is SELECTED, the count is announced once"
# Orca cannot run here (no accessibility bus), but the ATK objects it would
# read live in the shell. Without them (accessibility off) there is nothing
# to check.
SELECTED_STATE="imports.gi.Atk.StateType.SELECTED"
ONLY_SELECTED="$BAR._rows.every((r, i) => r.get_accessible().ref_state_set().contains_state($SELECTED_STATE) ===
    (r.visible && $BAR._offset + i === $BAR._selected))"
if is_true "$BAR._entry.get_accessible() !== null && $BAR._rows.every(r => r.get_accessible() !== null)"; then
    expect "$BAR._rows.filter(r => r.visible).every(r => {
        const sb = r._sb, name = r.get_accessible().get_name();
        return name === r.accessible_name && name.startsWith(sb.name.text + ', ') &&
            name.endsWith(', ' + sb.result.sourceName);
    })" "a row has no accessible name, or it lacks its name or source"
    expect "(() => {
        const i = $BAR._results.findIndex(r => r.kind === 'window' && r.name === 'Editor');
        return $BAR._rows[i - $BAR._offset].accessible_name.includes(', ' + $BAR._results[i].description + ', ');
    })()" "the Editor window's accessible name lacks its description"
    expect "$ONLY_SELECTED" "SELECTED is not on the selected row only"
    key Down
    wait_for "$BAR._selected === 1 && $ONLY_SELECTED" "SELECTED did not move with the selection"
    expect "global.stage.key_focus === $BAR._entry.clutter_text" "the keyboard left the search field"
    key Up
    wait_for "$BAR._selected === 0" "Up did not move the selection"
else
    echo "  skipped: get_accessible() is null in this session"
fi
close_now
# Rows are reused: with three rows, Down past the third keeps the selection
# on the last row while it shows other results. Each move must still say
# SELECTED on a row.
set_key visible-rows 3
open_bar
search e
if is_true "$BAR._rows.every(r => r.get_accessible() !== null)"; then
    expect "$BAR._results.length > 4" "not enough results for 'e'"
    run "(() => {
        global._sbSelectedEvents = [0, 0, 0];
        $BAR._rows.forEach((r, i) => r.get_accessible().connect('state-change', (_a, name, on) => {
            if (name === 'selected' && on)
                global._sbSelectedEvents[i]++;
        }));
        return 1;
    })()"
    for _ in 1 2 3 4; do key Down; done
    wait_for "$BAR._selected === 4 && $BAR._offset === 2 && $ONLY_SELECTED" "the list did not scroll to the selection"
    # Down 1 and 2 move to rows 1 and 2; Down 3 and 4 scroll, row 2 again.
    expect "global._sbSelectedEvents.join(' ') === '0 1 3'" "a reused row did not say SELECTED for its new result"
    expect "global.stage.key_focus === $BAR._entry.clutter_text" "the keyboard left the search field"
else
    echo "  skipped: get_accessible() is null in this session"
fi
close_now
dconf reset "${P}visible-rows"; pause 0.3
# The count, "Searching…" and "No results" go to the field's accessible as
# polite notifications, once the reports have paused for 500 ms.
open_bar
if is_true "$BAR._entry.get_accessible() !== null"; then
    run "(() => {
        const b = $BAR, set = b._setResults, now = () => imports.gi.GLib.get_monotonic_time() / 1000;
        global._sbSpoken = [];
        global._sbLastReport = 0;
        b._setResults = function (...args) { global._sbLastReport = now(); return set.apply(this, args); };
        b._entry.get_accessible().connect('notification', (_a, text, live) => {
            global._sbSpoken.push({text, live, after: now() - global._sbLastReport});
        });
        return 1;
    })()"
    search edi
    pause 0.8
    expect "global._sbSpoken.length === 1 &&
        global._sbSpoken[0].text.includes(String($BAR._results.length)) &&
        global._sbSpoken[0].live === imports.gi.Atk.Live.POLITE" "the count was not announced once, politely"
    expect "global._sbSpoken[0].after >= 490" "the count was announced before the reports paused"
    # The same results again: nothing new to say.
    run "(() => {
        const b = $BAR;
        b._setResults(b._results.map(r => ({...r})), false, {terms: b._resultsTerms, ready: true});
        return 1;
    })()"
    pause 0.8
    expect "global._sbSpoken.length === 1" "the same count was announced again"
    search xyzzy
    pause 0.8
    expect "global._sbSpoken.length === 2 && global._sbSpoken[1].text === $BAR._status.text" "'No results' was not announced"
    search xyzzyq
    pause 0.8
    expect "global._sbSpoken.length === 2" "'No results' was announced twice in a row"
    # Closing drops an announcement still waiting.
    run "global._sbClosing = $BAR; $BAR._scheduleAnnouncement(); $BAR.close(); 1"
    expect "global._sbClosing._announceTimeoutId === 0" "closing left the announcement's timeout behind"
    wait_for "$BAR === null" "the bar did not close"
    run "delete global._sbClosing; 1"
else
    echo "  skipped: get_accessible() is null in this session"
    close_now
fi
# Where scenario 4 starts: the results for "edi".
open_bar
search edi

echo "4. Down moves the highlight, wrapping at the end; Up comes back"
key Down
wait_for "$BAR._selected === 1 && $HIGHLIGHT_ON_ROW" "Down did not move the highlight to the second result"
expect "Math.abs($BAR._rows[0]._sb.icon.scale_x - 1) < 0.01" "the previous icon did not shrink back"
run "$BAR._select($BAR._results.length - 1); 1"; pause 0.4
key Down
wait_for "$BAR._selected === 0 && $HIGHLIGHT_ON_ROW" "Down did not wrap to the first result"
key Up
wait_for "$BAR._selected === $BAR._results.length - 1" "Up did not wrap to the last result"
key Escape
wait_for "$BAR === null && $UI_GONE && Main.modalCount === 0" "Escape did not close and destroy the bar"

echo "4b. Enter right after typing opens a result of what was typed, never an old one"
# A long delay makes sure Enter comes while the search still waits for the
# typing to pause; activation is recorded instead of opening anything.
set_key search-delay 400
record_activation() {
    run "(() => { const s = $BAR._searcher; s.activate = r => { global._sbActivated = r.kind + ':' + r.id; }; return 1; })()"
}
open_bar
run "global._sbActivated = null; 1"
record_activation
first=$(js "$BAR._results[0]?.id ?? ''" | sed "s/^(true, '\(.*\)')$/\1/; s/^\"//; s/\"$//")
# The test app that is not the first frequent one, so opening it proves the
# stale list was not used.
if [ "$first" = org.search_bar.Files.desktop ]; then target=Editor; else target=Files; fi
expect "$BAR._results.length > 0 && !$BAR._searcher.pending" "no frequent apps before typing"
type_text "$(tr 'A-Z' 'a-z' <<<"$target")"
expect "$BAR._searcher.pending" "the search did not wait for the delay (the test proves nothing)"
key Return
wait_for "global._sbActivated !== null" "Enter opened nothing"
expect "global._sbActivated === 'app:org.search_bar.$target.desktop'" "Enter opened an old result instead of $target"
wait_for "$BAR === null" "the bar did not close"
echo "4c. Enter on a search that finds nothing opens nothing"
open_bar
run "global._sbActivated = null; 1"
record_activation
type_text xyzzy
key Return
pause 0.9
expect "global._sbActivated === null && $BAR?.isOpen && !$BAR._activatePending" \
    "Enter opened something for a search with no results, or still waits"
close_now
dconf reset "${P}search-delay"; pause 0.3

echo "4d. frequent apps follow parental controls"
FREQUENT="$BAR._results.map(r => r.id)"
open_bar
expect "$FREQUENT.includes('org.search_bar.Editor.desktop') && $FREQUENT.includes('org.search_bar.Files.desktop')" \
    "the test apps are not among the frequent apps (the test proves nothing)"
close_now
# What a parental controls filter that denies the Editor does.
run "import('resource:///org/gnome/shell/misc/parentalControlsManager.js').then(m => {
    const manager = m.getDefault(), show = manager.shouldShowApp;
    global._sbParental = manager;
    manager.shouldShowApp = function (info) {
        return info.get_id() !== 'org.search_bar.Editor.desktop' && show.call(this, info);
    };
}); 1"
wait_for "global._sbParental?.hasOwnProperty('shouldShowApp')" "could not filter apps"
open_bar
expect "!$FREQUENT.includes('org.search_bar.Editor.desktop') && $FREQUENT.includes('org.search_bar.Files.desktop')" \
    "an app denied by parental controls is among the frequent apps"
close_now
run "delete global._sbParental.shouldShowApp; delete global._sbParental; 1"

echo "5. every selection style, mid-move (900 ms) and settled"
set_key animation-duration 900
set_key focus-scale 120
n=10
for style in ${SB_STYLES:-slide stretch liquid jelly pop fade}; do
    set_key animation "'$style'"
    open_bar
    search e
    expect "$BAR._results.length >= 4" "not enough results for 'e'"
    run "$BAR._select(3); 1"
    pause 0.3
    if [ "$style" = liquid ]; then
        expect "$BAR._drop.visible && $BAR._shape?.vertical" "liquid: the drop is not showing"
    fi
    shot "$n-style-$style"
    n=$((n + 1))
    wait_for "$HIGHLIGHT_ON_ROW" "$style: the highlight did not settle on the fourth result"
    expect "!$BAR._drop.visible" "$style: the drop is still showing"
    close_now
done
dconf reset "${P}animation-duration"; dconf reset "${P}animation"; dconf reset "${P}focus-scale"
pause 0.5

echo "6. the list scrolls like rofi's when the selection leaves it"
set_key visible-rows 3
open_bar
search e
expect "$BAR._results.length > 3 && $BAR._rows.length === 3" "no more results than rows"
for _ in 1 2 3 4; do key Down; done
wait_for "$BAR._selected === 4 && $BAR._offset === 2 && $HIGHLIGHT_ON_ROW" "the list did not scroll to the selection"
expect "$BAR._rows[2]._sb.result === $BAR._results[4]" "the last row does not show the selected result"
close_now

echo "6b. rows keep their icons while scrolling and when sources report the same results"
open_bar
search e
expect "$BAR._results.length > 4" "not enough results for 'e'"
# Counts the rows refilled, and remembers the first row's icon.
run "(() => {
    const b = $BAR, fill = b._fillRow;
    global._sbFills = 0;
    b._fillRow = function (...args) { global._sbFills++; return fill.apply(this, args); };
    global._sbIcon = b._rows[0]._sb.icon.get_child();
    return 1;
})()"
expect "global._sbIcon !== null" "the first row has no icon"
for _ in 1 2 3; do key Down; done
wait_for "$BAR._selected === 3 && $BAR._offset === 1" "the list did not scroll down"
for _ in 1 2 3; do key Up; done
wait_for "$BAR._selected === 0 && $BAR._offset === 0" "the list did not scroll back"
expect "$BAR._rows[0]._sb.icon.get_child() === global._sbIcon" "scrolling back built a new icon instead of reusing it"
expect "global._sbFills === 6" "rows were refilled without scrolling"
# What every source answering does: the same results, in new objects.
run "(() => {
    const b = $BAR;
    global._sbFills = 0;
    b._setResults(b._results.map(r => ({...r})), false, {terms: b._resultsTerms, ready: true});
    return 1;
})()"
expect "global._sbFills === 0 && $BAR._rows[0]._sb.icon.get_child() === global._sbIcon" \
    "the same results reported again rebuilt the rows"
expect "$BAR._icons.size <= $BAR._results.length" "icons of results no longer shown are kept"
# Two providers that find nothing, answering after the apps: they change
# nothing, so only the last answer is reported (to end "Searching…").
run "(() => {
    const fake = (id, ms) => ({
        id, appInfo: null,
        getInitialResultSet: () => new Promise(resolve => setTimeout(() => resolve([]), ms)),
        getSubsearchResultSet: () => new Promise(resolve => setTimeout(() => resolve([]), ms)),
        filterResults: (ids, max) => ids.slice(0, max),
        getResultMetas: () => Promise.resolve([]),
        activateResult() {},
    });
    global._sbProviders = Main.overview._overview.controls._searchController._searchResults._providers;
    global._sbFakes = [fake('sb-fake-1', 300), fake('sb-fake-2', 600)];
    global._sbProviders.push(...global._sbFakes);
    const b = $BAR, set = b._setResults;
    global._sbReports = 0;
    b._setResults = function (...args) { global._sbReports++; return set.apply(this, args); };
    b._entry.text = 'ed';
    return 1;
})()"
wait_for "$BAR._searcher.terms.join(' ') === 'ed' && !$BAR._searching" "the search with two more providers did not finish"
run "(() => {
    const p = global._sbProviders;
    global._sbFakes.forEach(f => p.splice(p.indexOf(f), 1));
    delete global._sbFakes;
    return 1;
})()"
expect "global._sbReports === 2" "providers that changed nothing were reported"
close_now

echo "6c. the list's height eases once: opening, moving the selection or the same height again never restart or cut it"
run "$STATE.toggle(); global._sbOpening = $BAR._panel.get_transition('height') === null; 1"
expect "global._sbOpening" "the first results eased the height on top of the opening"
wait_for "$BAR?.isOpen && $BAR._reveal === 1 && !$BAR._revealTimeline" "the bar did not open"
search e
expect "$BAR._results.length > 2" "not enough results for 'e'"
# Fewer results start an ease; in the same frame, a move and the same
# results again must leave that very transition running.
run "(() => {
    const b = $BAR, p = b._panel, again = () => b._results.slice(0, 2).map(r => ({...r}));
    global._sbHeight = p.height;
    b._setResults(again(), false, {terms: b._resultsTerms, ready: true});
    const t = p.get_transition('height');
    global._sbEase = t !== null;
    b._select(1);
    global._sbAfterSelect = p.get_transition('height') === t;
    b._setResults(again(), false, {terms: b._resultsTerms, ready: true});
    global._sbAfterReport = p.get_transition('height') === t;
    return 1;
})()"
expect "global._sbEase" "fewer results did not ease the height (the test proves nothing)"
expect "global._sbAfterSelect" "moving the selection cut the height's ease"
expect "global._sbAfterReport" "the same height again restarted the ease"
wait_for "!$BAR._panel.get_transition('height') && $BAR._panel.height < global._sbHeight" "the height did not settle"
close_now
dconf reset "${P}visible-rows"; pause 0.3

echo "7. Enter on a window focuses it; system actions only log in the dry run"
run "global.display.list_all_windows().find(w => w.get_title() === 'Files').activate(global.get_current_time()); 1"
pause 0.5
open_bar
search Editor
run "$BAR._select($BAR._results.findIndex(r => r.kind === 'window')); 1"
pause 0.3
key Return
wait_for "$BAR === null && global.display.focus_window?.get_title() === 'Editor'" "Enter did not focus the Editor window"
open_bar
# Actions available depend on the session (and their names on its
# language): take whichever one 'e' finds, such as Log Out.
search e
expect "$BAR._results.some(r => r.kind === 'action')" "no system action found"
run "$BAR._select($BAR._results.findIndex(r => r.kind === 'action')); 1"
key Return
pause 0.5
grep -q "dry run: would activate action" "$log" || { echo "FAILED: the action was not dry-run"; exit 1; }
expect "$BAR === null && Main.modalCount === 0" "the bar did not close on the action"

echo "8. sources can be turned off"
set_key disabled-sources "['windows']"
open_bar
search edi
expect "!$BAR._results.some(r => r.kind === 'window') && $BAR._results.some(r => r.kind === 'app')" \
    "windows were shown although turned off"
close_now
set_key disabled-sources "['applications', 'actions']"
open_bar
search edi
expect "$BAR._results.length > 0 && $BAR._results.every(r => r.kind === 'window')" "apps were shown although turned off"
search xyzzy
# The text is translated; it must be the finished one, not "Searching…".
expect "$BAR._results.length === 0 && $BAR._status.visible && !$BAR._searching && $BAR._status.text !== ''" \
    "no 'No results' for a search that finds nothing"
shot 20-no-results
close_now
dconf reset "${P}disabled-sources"; pause 0.3

echo "8b. what a search provider sends is checked: bad metas dropped, long names cut, a broken icon only costs itself"
run "(() => {
    const metas = [
        {id: 'sb-number', name: 42, description: 7, createIcon: () => null},
        {name: 'Without an id'},
        {id: 'sb-long', name: 'L'.repeat(100000), description: 'D'.repeat(100000)},
        {id: 'sb-broken', name: 'Broken icon', createIcon: () => { throw new Error('SB_EXPECTED icon'); }},
    ];
    global._sbProviders = Main.overview._overview.controls._searchController._searchResults._providers;
    global._sbFake = {
        id: 'sb-fake', appInfo: null,
        getInitialResultSet: async () => ['sb-number', 'sb-none', 'sb-long', 'sb-broken'],
        getSubsearchResultSet: async () => ['sb-number', 'sb-none', 'sb-long', 'sb-broken'],
        filterResults: (ids, max) => ids.slice(0, max),
        getResultMetas: async () => metas,
        activateResult() {},
    };
    global._sbProviders.push(global._sbFake);
    return 1;
})()"
open_bar
search qqq
FAKE="$BAR._results.filter(r => r.source === 'sb-fake')"
expect "$FAKE.map(r => r.id).join(' ') === 'sb-number sb-long sb-broken'" "the provider's valid results are not all there"
expect "$FAKE.every(r => typeof r.name === 'string' && typeof r.description === 'string') && $FAKE[0].name === '42'" \
    "a number from a provider was not turned into text"
expect "$FAKE[1].name.length === 512 && $FAKE[1].description.length === 512" "a long name was not cut"
expect "$BAR._rows.filter(r => r.visible).length === $BAR._results.length && $HIGHLIGHT_ON_ROW" \
    "the rows were not all filled"
# The list still moves and updates.
key Down
wait_for "$BAR._selected === 1 && $HIGHLIGHT_ON_ROW" "the list does not move after the broken icon"
type_text q
wait_for "$BAR._searcher.terms.join(' ') === 'qqqq' && !$BAR._searching && $BAR._selected === 0" \
    "the list does not update after the broken icon"
expect "$FAKE.length === 3" "the provider's results are gone after a new search"
close_now
run "global._sbProviders.splice(global._sbProviders.indexOf(global._sbFake), 1); delete global._sbFake; 1"

echo "9. dragging the edge moves the bar and the place is saved"
# Counts the writes to these settings, seen from another settings object.
WRITES="(() => {
    global._sbWrites = 0;
    global._sbWatch?.disconnect(global._sbWatchId);
    global._sbWatch = new imports.gi.Gio.Settings({settings_schema: $SET.settings_schema});
    global._sbWatchId = global._sbWatch.connect('change-event', () => { global._sbWrites++; });
    return 1;
})()"
open_bar
search e
run "$WRITES"
run "global._sbStart = [$BAR._panel.x, $BAR._panel.y]; 1"
px=$(js "$BAR._panel.x + 5" | grep -o '[0-9.]\+' | head -1)
py=$(js "$BAR._panel.y + 30" | grep -o '[0-9.]\+' | head -1)
pointer_to "$px" "$py"
button PRESSED
for step in 1 2 3 4 5; do pointer_to "$((${px%.*} - step * 40))" "$((${py%.*} - step * 20))"; done
button RELEASED
pause 0.3
expect "$BAR._panel.x === global._sbStart[0] - 200 && $BAR._panel.y === global._sbStart[1] - 100" \
    "the bar did not follow the pointer"
wait_for "$SET.get_string('position') === 'custom'" "the position was not saved as custom"
pause 0.3
expect "global._sbWrites === 1" "the place was saved in several writes"
run "global._sbPlace = [$BAR._panel.x, $BAR._panel.y]; 1"
shot 21-moved
close_now
open_bar
expect "Math.abs($BAR._panel.x - global._sbPlace[0]) <= 1 && Math.abs($BAR._panel.y - global._sbPlace[1]) <= 1" \
    "the saved position was not restored"

echo "10. dragging the grip resizes the bar, in whole rows, and the size is saved"
run "$WRITES"
gx=$(js "$BAR._panel.x + $BAR._grip.x + 7" | grep -o '[0-9.]\+' | head -1)
gy=$(js "$BAR._panel.y + $BAR._grip.y + 7" | grep -o '[0-9.]\+' | head -1)
pointer_to "$gx" "$gy"
button PRESSED
for step in 1 2 3 4; do pointer_to "$((${gx%.*} + step * 30))" "$((${gy%.*} + step * 26))"; done
expect "$BAR._config.width === 760 && $BAR._config.rows === 10 && $BAR._panel.has_style_pseudo_class('resizing')" \
    "resizing did not follow the pointer"
shot 22-resizing
button RELEASED
wait_for "$SET.get_int('width') === 760 && $SET.get_int('visible-rows') === 10" "the size was not saved"
pause 0.3
expect "global._sbWrites === 1" "the size was saved in several writes"
close_now
open_bar
expect "$BAR._panel.width === 760 && $BAR._rows.length === 10" "the saved size was not used"
close_now
for k in position custom-x custom-y width visible-rows; do dconf reset "$P$k"; done

echo "11. without saving, moving lasts until the bar closes"
set_key remember-geometry false
open_bar
run "global._sbStart = [$BAR._panel.x, $BAR._panel.y]; 1"
px=$(js "$BAR._panel.x + 5" | grep -o '[0-9.]\+' | head -1)
py=$(js "$BAR._panel.y + 30" | grep -o '[0-9.]\+' | head -1)
pointer_to "$px" "$py"; button PRESSED; pointer_to "$((${px%.*} + 120))" "$py"; button RELEASED
pause 0.3
expect "$BAR._panel.x === global._sbStart[0] + 120 && $SET.get_string('position') === 'center'" \
    "the move was saved although saving is off"
close_now
open_bar
expect "$BAR._panel.x === global._sbStart[0]" "the bar did not go back to its place"
close_now
dconf reset "${P}remember-geometry"; pause 0.3

echo "11b. a click on the magnifier or a wobble under 4 px moves and saves nothing; the pointer shows the handles"
CURSOR="imports.gi.Clutter.CursorType"
open_bar
expect "$BAR._panel.get_cursor_type() === $CURSOR.MOVE && $BAR._handle.get_cursor_type() === $CURSOR.MOVE &&
    $BAR._grip.get_cursor_type() === $CURSOR.SE_RESIZE && $BAR._entry.get_cursor_type() === $CURSOR.TEXT &&
    $BAR._list.get_cursor_type() === $CURSOR.DEFAULT && $BAR._root.get_cursor_type() === $CURSOR.INHERIT" \
    "the edge, the magnifier, the grip, the field or the list has the wrong pointer"
run "$WRITES"
run "global._sbStart = [$BAR._panel.x, $BAR._panel.y]; 1"
hx=$(js "(() => { const [x] = $BAR._handle.get_transformed_position(); return Math.round(x + $BAR._handle.width / 2); })()" |
    grep -o '[0-9]\+' | head -1)
hy=$(js "(() => { const [, y] = $BAR._handle.get_transformed_position(); return Math.round(y + $BAR._handle.height / 2); })()" |
    grep -o '[0-9]\+' | head -1)
pointer_to "$hx" "$hy"; button PRESSED; button RELEASED
pointer_to "$hx" "$hy"; button PRESSED; pointer_to "$((hx + 2))" "$((hy + 2))"
expect "$BAR._drag && !$BAR._drag.started && $BAR._root.get_cursor_type() === $CURSOR.INHERIT" \
    "a 2 px wobble started a drag"
button RELEASED
pause 0.3
expect "$BAR._panel.x === global._sbStart[0] && $BAR._panel.y === global._sbStart[1]" "a click moved the bar"
expect "$SET.get_string('position') === 'center' && global._sbWrites === 0" "a click saved a custom position"
# A real drag shows its pointer wherever it goes, until the release.
pointer_to "$hx" "$hy"; button PRESSED; pointer_to "$((hx + 30))" "$hy"
expect "$BAR._drag?.started && $BAR._root.get_cursor_type() === $CURSOR.MOVE && $BAR._list.get_cursor_type() === $CURSOR.MOVE" \
    "a drag does not show the move pointer"
button RELEASED
expect "$BAR._root.get_cursor_type() === $CURSOR.INHERIT && $BAR._list.get_cursor_type() === $CURSOR.DEFAULT" \
    "the pointer did not come back after the drag"
wait_for "$SET.get_string('position') === 'custom'" "a real drag of the magnifier was not saved"
close_now
for k in position custom-x custom-y; do dconf reset "$P$k"; done; pause 0.3

echo "12. clicking outside closes; closing animates, then nothing is left"
set_key open-duration 900
open_bar
pointer_to 20 780
button PRESSED; button RELEASED
pause 0.25
expect "$BAR && !$BAR.isOpen && $BAR._revealTimeline?.is_playing() && Main.modalCount === 0" \
    "clicking outside did not start closing, or the grab is still held"
shot 23-closing
wait_for "$BAR === null && $UI_GONE" "the bar was not destroyed after closing"

echo "13. every opening style, mid-way"
n=30
for style in zoom slide unfold fade; do
    set_key open-animation "'$style'"
    run "$STATE.toggle(); 1"
    pause 0.25
    expect "$BAR._revealTimeline?.is_playing()" "$style: the opening is not animating"
    shot "$n-open-$style"
    n=$((n + 1))
    wait_for "$BAR._reveal === 1 && $BAR._panel.opacity === 255 && $BAR._panel.scale_x === 1 &&
        $BAR._panel.translation_y === 0" "$style: the bar did not settle fully open"
    close_now
done
echo "13b. reopening while closing continues from where it is"
open_bar
run "$BAR.close(); 1"; pause 0.2
run "global._sbReveal = $BAR._reveal; $STATE.toggle(); 1"
expect "$BAR.isOpen && $BAR._reveal > 0.3 && Math.abs($BAR._reveal - global._sbReveal) < 0.1" \
    "reopening jumped instead of continuing"
wait_for "$BAR._reveal === 1" "reopening did not finish"
close_now
dconf reset "${P}open-duration"; dconf reset "${P}open-animation"; pause 0.3

echo "14. disabling while the bar is open and animating takes everything away"
set_key animation-duration 900
open_bar
search e
run "$BAR._select(3); 1"; pause 0.2
run "Main.extensionManager.disableExtension('$SEARCH_BAR_UUID'); 1"; pause 0.5
expect "$UI_GONE" "disable left the bar behind"
expect "Main.modalCount === 0" "disable left the grab behind"
expect "(Main.wm._allowedKeybindings['search-bar-toggle'] ?? 0) === 0" "disable left the shortcut behind"
expect "global.stage.key_focus === null || !global.stage.key_focus.get_stage" "the keyboard focus is stuck"
run "Main.extensionManager.enableExtension('$SEARCH_BAR_UUID'); 1"; pause 0.5
expect "$EXT.state === 1 && $BAR === null" "extension did not start again"
press_shortcut
wait_for "$BAR?.isOpen" "the shortcut does not open the bar after enabling again"
close_now

echo "14b. a registration left behind does not take the shortcut away"
run "Main.extensionManager.disableExtension('$SEARCH_BAR_UUID'); 1"; pause 0.3
# What a disable() that never finished would leave: the same keybinding
# name, registered with a handler that does nothing.
run "Main.wm.addKeybinding('search-bar-toggle', $STATE.getSettings(), imports.gi.Meta.KeyBindingFlags.NONE,
    imports.gi.Shell.ActionMode.NORMAL, () => {}); 1"
run "Main.extensionManager.enableExtension('$SEARCH_BAR_UUID'); 1"; pause 0.5
press_shortcut
wait_for "$BAR?.isOpen" "a stale keybinding kept the shortcut from opening the bar"
close_now
dconf reset "${P}animation-duration"; pause 0.3

echo "14c. an error while opening or closing never leaves the screen covered or grabbed"
# Errors are injected on purpose; their messages carry SB_EXPECTED so the
# log check at the end ignores them, and only them.
LAYER_COUNT="Main.layoutManager.uiGroup.get_n_children()"
NOTHING_LEFT="$UI_GONE && Main.modalCount === 0 && !Main.layoutManager.uiGroup.get_children().some(a =>
    a.reactive && a.width === global.stage.width && a.height === global.stage.height && a.constructor.name === 'StWidget')"
open_bar
run "global._sbProto = Object.getPrototypeOf($BAR); 1"
close_now
run "global._sbLayers = $LAYER_COUNT; 1"
# a) The constructor throws after the layer is on the stage: the frequent
# apps are read at the end of it.
run "(() => { const u = imports.gi.Shell.AppUsage.get_default(); global._sbUsage = u;
    u.get_most_used = () => { throw new Error('SB_EXPECTED constructor failure'); }; return 1; })()"
run "$STATE.toggle(); 1"; pause 0.3
expect "$BAR === null && $NOTHING_LEFT && $LAYER_COUNT === global._sbLayers" \
    "a failing constructor left its layer on the screen"
run "delete global._sbUsage.get_most_used; 1"
# b) open() throws after taking the keyboard and the pointer.
run "global._sbProto._sbReveal = global._sbProto._animateReveal;
    global._sbProto._animateReveal = () => { throw new Error('SB_EXPECTED open failure'); }; 1"
run "$STATE.toggle(); 1"; pause 0.3
expect "$BAR === null && $NOTHING_LEFT && $LAYER_COUNT === global._sbLayers" "a failing open() left the grab or the layer"
run "global._sbProto._animateReveal = global._sbProto._sbReveal; delete global._sbProto._sbReveal; 1"
# c) Stopping a part throws inside destroy(): the grab and the layer still go.
open_bar
run "global._sbProto._sbStop = global._sbProto._stopHighlight;
    global._sbProto._stopHighlight = () => { throw new Error('SB_EXPECTED destroy failure'); }; 1"
run "(() => { try { $BAR.destroy(); } catch (e) {} $STATE._bar = null; return 1; })()"
expect "$NOTHING_LEFT && $LAYER_COUNT === global._sbLayers" "a failing destroy() left the grab or the layer"
run "global._sbProto._stopHighlight = global._sbProto._sbStop; delete global._sbProto._sbStop; 1"
# And everything works again.
press_shortcut
wait_for "$BAR?.isOpen" "the bar does not open after the injected errors"
close_now

echo "15. custom look: color, opacity, text size and darkened screen"
set_key highlight-color "'#f6d32d'"
set_key highlight-opacity 80
set_key font-size 18
set_key backdrop-opacity 40
open_bar
search e
expect "(() => {
    const c = $BAR._highlight.get_theme_node().get_background_color();
    return c.red === 0xf6 && c.green === 0xd3 && c.blue === 0x2d && Math.abs(c.alpha - 204) <= 1;
})()" "the custom highlight color or opacity is not used"
expect "$BAR._rows[0].get_style() === 'color: #000000;'" "no dark text on a light highlight"
expect "$BAR._panel.get_theme_node().get_font().get_size() / 1024 > 12" "the text size is not used"
expect "$BAR._backdrop.get_theme_node().get_background_color().alpha === 102" "the screen is not darkened"
expect "$ROWS_FIT" "with larger text, a result's two lines do not fit in its row"
shot 24-custom
close_now
# The same light color, faint: it shows dark over the bar, so light text.
set_key highlight-opacity 20
open_bar
search e
expect "$BAR._rows[0].get_style() === 'color: #ffffff;'" "dark text on a faint light highlight"
close_now
for k in highlight-color highlight-opacity font-size backdrop-opacity; do dconf reset "$P$k"; done; pause 0.3

echo "15b. large text with small icons: rows grow to hold both lines"
set_key icon-size 16
set_key font-size 28
open_bar
search e
expect "$BAR._rows[0].height > (16 + 16)" "rows did not grow beyond the icon for large text"
expect "$ROWS_FIT" "with large text and small icons, a result's two lines do not fit in its row"
close_now
dconf reset "${P}icon-size"; dconf reset "${P}font-size"; pause 0.3

echo "16. HiDPI: sizes follow the scale factor"
run "imports.gi.St.ThemeContext.get_for_stage(global.stage).scale_factor = 2; 1"; pause 1
open_bar
search e
expect "$BAR._panel.width === 1280 && $BAR._rows[0].height === 96" "sizes did not double at scale 2"
expect "$HIGHLIGHT_ON_ROW" "the highlight is off its row at scale 2"
close_now
run "imports.gi.St.ThemeContext.get_for_stage(global.stage).scale_factor = 1; 1"; pause 1

echo "17. with GNOME's animations off, everything is instant"
dconf write /org/gnome/desktop/interface/enable-animations false
wait_for "!imports.gi.St.Settings.get().enable_animations" "animations still on"
run "$STATE.toggle(); 1"
expect "$BAR.isOpen && $BAR._reveal === 1 && !$BAR._revealTimeline" "the opening animated with animations off"
search e
run "$BAR._select(2); 1"
expect "!$BAR._timeline && $HIGHLIGHT_ON_ROW" "the highlight animated with animations off"
run "$BAR.close(); 1"
expect "$BAR === null" "closing animated with animations off"
dconf reset /org/gnome/desktop/interface/enable-animations
wait_for "imports.gi.St.Settings.get().enable_animations" "animations did not come back"

echo "18. the default look, for the README"
open_bar
search e
run "$BAR._select(1); 1"; pause 0.5
shot 25-default
close_now

echo "19. preferences window"
n=40
# The preferences find the test's search provider in its data directory.
dbus-update-activation-environment XDG_DATA_HOME="$SEARCH_BAR_WORK/share"
for page in appearance animation sources behavior; do
    # The prefs app is D-Bus activated: pass the page through the activation
    # environment and restart only the instance on this private bus.
    dbus-update-activation-environment SEARCH_BAR_PREFS_PAGE=$page
    pid=$(gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus \
        --method org.freedesktop.DBus.GetConnectionUnixProcessID org.gnome.Shell.Extensions 2>/dev/null |
        grep -o '[0-9]\+' | tail -1 || true)
    [ -n "$pid" ] && kill "$pid" && pause 1
    gnome-extensions prefs "$SEARCH_BAR_UUID" >/dev/null 2>&1 || true
    pause 4
    shot "$n-preferences-$page"
    if [ "$page" = animation ]; then
        # The preview loops: over more than one move and pause, its area
        # (top center of the window) must change.
        for i in 1 2 3; do pause 0.7; shot "preview-$i"; done
        python3 - "$SEARCH_BAR_OUT" <<'PY' || { echo "FAILED: the preview does not move"; exit 1; }
import sys
from PIL import Image, ImageChops
out = sys.argv[1]
box = (400, 80, 880, 260)
first = Image.open(f"{out}/41-preferences-animation.png").convert("RGB").crop(box)
moved = any(ImageChops.difference(first, Image.open(f"{out}/preview-{i}.png").convert("RGB").crop(box)).getbbox()
            for i in (1, 2, 3))
sys.exit(0 if moved else 1)
PY
        rm -f "$SEARCH_BAR_OUT"/preview-*.png
    fi
    if [ "$page" = sources ]; then
        # Names from .desktop files are plain text: as markup, this one
        # fails to parse, and GTK says so.
        if grep -q "from markup" "$SEARCH_BAR_OUT/session.log"; then
            echo "FAILED: a provider's name was shown as markup"
            grep "from markup" "$SEARCH_BAR_OUT/session.log"
            exit 1
        fi
    fi
    n=$((n + 1))
done

# The shell logs to shell.log; the preferences, a separate process on this
# bus, to session.log.
# Errors injected on purpose by scenario 14c say SB_EXPECTED.
errors=$(grep -E "JS ERROR|JS WARNING|$SEARCH_BAR_UUID.*(rror|Exception)|Gjs-CRITICAL" "$log" "$SEARCH_BAR_OUT/session.log" |
    grep -v SB_EXPECTED || true)
if [ -n "$errors" ]; then
    echo "FAILED: errors in the logs"
    echo "$errors"
    exit 1
fi
echo "OK: no JavaScript errors (log: $log)"
