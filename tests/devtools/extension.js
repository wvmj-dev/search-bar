// Test helper for tests/smoke.sh, installed only in a throwaway headless
// shell. Unsafe mode lets the test call org.gnome.Shell.Eval and take
// screenshots over D-Bus. Never install this in a real session.
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export default class DevtoolsExtension extends Extension {
    enable() {
        Main.messageTray.bannerBlocked = true;
        global.context.unsafe_mode = true;
    }

    disable() {
        global.context.unsafe_mode = false;
        Main.messageTray.bannerBlocked = false;
    }
}
