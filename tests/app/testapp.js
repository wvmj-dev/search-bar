// Tiny GTK app used by tests/smoke.sh inside the headless shell, so the
// extension has real windows to work with. The app id and title come from
// the command line, so one script plays several apps; every activation
// opens a window.
//   gjs -m testapp.js <application id> <title>
import Gtk from 'gi://Gtk?version=4.0';
import System from 'system';

const [id, title] = System.programArgs;
const app = new Gtk.Application({application_id: id});
app.connect('activate', () => {
    const window = new Gtk.ApplicationWindow({application: app, title,
        default_width: 480, default_height: 320});
    window.set_child(new Gtk.Label({label: title}));
    window.present();
});
app.run([]);
