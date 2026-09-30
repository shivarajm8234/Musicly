import GObject from 'gi://GObject';
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class MusiclyPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: _('Appearance'),
        });

        const compactSwitch = new Adw.SwitchRow({
            title: _('Compact Mode'),
            subtitle: _('Show only the player icon without text'),
        });
        
        // This is a placeholder for actual GSettings binding.
        // A complete extension would define a GSettings schema and bind this switch to it.

        group.add(compactSwitch);
        page.add(group);
        window.add(page);
    }
}
