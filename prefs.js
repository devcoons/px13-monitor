import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class HardwareMonitorPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'temperature-symbolic',
        });
        window.add(page);

        const appearance = new Adw.PreferencesGroup({
            title: 'Appearance',
        });
        page.add(appearance);
        this._switch(appearance, settings, 'compact', 'Compact mode', 'CPU temperature and its fan, then GPU temperature and its fan');
        this._switch(appearance, settings, 'fan-pad', 'Fixed-width fan speeds', 'Leading zeros stay visible, drawn dimmer than the rest');
        this._spin(appearance, settings, 'fan-digits', 'Fan digits', 'Padded width, and the fan graph tops out one past that range', 2, 6, 1);

        const display = new Adw.PreferencesGroup({
            title: 'Top bar',
        });
        page.add(display);
        this._switch(display, settings, 'show-cpu', 'CPU temperature', 'Package or Tctl reading');
        this._switch(display, settings, 'show-gpu', 'GPU temperature', 'Graphics temperature, edge sensor when AMD exposes one');
        this._switch(display, settings, 'show-fan', 'Fan speed', 'Each fan, in rpm. ASUS cpu_fan and gpu_fan are preferred');
        this._switch(display, settings, 'show-ram', 'Memory use', 'Percentage of RAM in use');

        const behavior = new Adw.PreferencesGroup({
            title: 'Behavior',
        });
        page.add(behavior);
        this._spin(behavior, settings, 'refresh-interval', 'Refresh interval', 'Seconds between readings', 1, 30, 1);

        const unit = new Adw.ComboRow({
            title: 'Temperature unit',
            model: Gtk.StringList.new(['Celsius', 'Fahrenheit']),
            selected: settings.get_string('unit') === 'fahrenheit' ? 1 : 0,
        });
        unit.connect('notify::selected', () => {
            const next = unit.selected === 1 ? 'fahrenheit' : 'celsius';
            if (settings.get_string('unit') !== next)
                settings.set_string('unit', next);
        });
        behavior.add(unit);

        const temperatures = new Adw.PreferencesGroup({
            title: 'Temperature',
            description: 'Degrees Celsius. High is yellow, warn is orange, critical is red.',
        });
        page.add(temperatures);
        this._spin(temperatures, settings, 'temp-high', 'High', 'Yellow', 30, 120, 1);
        this._spin(temperatures, settings, 'temp-warn', 'Warn', 'Orange', 30, 120, 1);
        this._spin(temperatures, settings, 'temp-crit', 'Critical', 'Red', 30, 120, 1);

        const memory = new Adw.PreferencesGroup({
            title: 'Memory',
            description: 'Percent of RAM in use. High is yellow, warn is orange, critical is red.',
        });
        page.add(memory);
        this._spin(memory, settings, 'ram-high', 'High', 'Yellow', 1, 100, 1);
        this._spin(memory, settings, 'ram-warn', 'Warn', 'Orange', 1, 100, 1);
        this._spin(memory, settings, 'ram-crit', 'Critical', 'Red', 1, 100, 1);

        const about = new Adw.PreferencesGroup({
            title: 'Sensors',
            description: 'Readings come from /sys/class/hwmon and /proc/meminfo, so the same extension works on other laptops. On the ASUS ProArt PX13 it uses k10temp, amdgpu, and the ASUS fan controller.',
        });
        page.add(about);
    }

    _switch(group, settings, key, title, subtitle) {
        const row = new Adw.SwitchRow({title, subtitle});
        group.add(row);
        settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    }

    _spin(group, settings, key, title, subtitle, lower, upper, step) {
        const row = new Adw.SpinRow({
            title,
            subtitle,
            adjustment: new Gtk.Adjustment({
                lower,
                upper,
                step_increment: step,
                page_increment: step * 5,
                value: settings.get_int(key),
            }),
        });
        group.add(row);

        const updateFromSettings = () => {
            const value = settings.get_int(key);
            if (Math.round(row.value) !== value)
                row.value = value;
        };
        row.connect('notify::value', () => {
            const value = Math.round(row.value);
            if (settings.get_int(key) !== value)
                settings.set_int(key, value);
        });
        settings.connect(`changed::${key}`, updateFromSettings);
    }
}
