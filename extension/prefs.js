import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const BUS_NAME = 'io.github.soefyan45.Notchline';
const OBJECT_PATH = '/io/github/soefyan45/Notchline';

const NotchlineIface = `
<node>
  <interface name="io.github.soefyan45.Notchline">
    <method name="SetConfig">
      <arg type="s" name="json" direction="in"/>
    </method>
    <property name="Config" type="s" access="read"/>
  </interface>
</node>`;

const NotchlineProxy = Gio.DBusProxy.makeProxyWrapper(NotchlineIface);

// Wait for typing or dragging a slider to pause before writing config.toml
const SAVE_DELAY_MS = 250;
const COMING_SOON = 'Coming soon: this feature is planned for a later release.';

// Notch color each theme starts from; picking a theme also sets pill.background
const THEME_NOTCH = {default: '#000000', te: '#0F0E12'};

// Theme "te" in this window: the orange accent in place of Adwaita's blue. Scoped to the
// window's class because preferences of other extensions share this process.
const TE_CSS = `
window.notchline-theme-te switch:checked,
window.notchline-theme-te check:checked,
window.notchline-theme-te radio:checked,
window.notchline-theme-te button.suggested-action {
    background-color: #F05A24;
    color: #0F0E12;
}
window.notchline-theme-te .navigation-sidebar > row:selected {
    background-color: alpha(#F05A24, 0.18);
}
window.notchline-theme-te link,
window.notchline-theme-te .accent {
    color: #F05A24;
}
window.notchline-theme-te *:focus-visible {
    outline-color: alpha(#F05A24, 0.5);
}`;

// A row whose texts are shown as typed, not parsed as Pango markup
function plainRow({title, subtitle = '', ...props}) {
    const row = new Adw.ActionRow({use_markup: false, ...props});
    row.title = title;
    row.subtitle = subtitle;
    return row;
}

function hexToRgba(hex) {
    const rgba = new Gdk.RGBA();
    rgba.parse(hex ?? '#000000');
    return rgba;
}

function rgbaToHex(rgba) {
    const channel = value => Math.round(value * 255).toString(16).padStart(2, '0');
    return `#${channel(rgba.red)}${channel(rgba.green)}${channel(rgba.blue)}`;
}

export default class NotchlinePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        this._config = {};
        this._refreshers = [];
        this._syncing = false;
        this._saveId = 0;
        this._error = null;

        try {
            this._proxy = new NotchlineProxy(Gio.DBus.session, BUS_NAME, OBJECT_PATH);
            this._config = JSON.parse(this._proxy.Config || '{}');
            this._proxy.connect('g-properties-changed', () => this._reload());
        } catch (e) {
            this._error = e.message;
        }

        const css = new Gtk.CssProvider();
        css.load_from_string(TE_CSS);
        Gtk.StyleContext.add_provider_for_display(window.get_display(), css,
            Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
        const refreshTheme = () => {
            if (this._get(['pill', 'theme']) === 'te')
                window.add_css_class('notchline-theme-te');
            else
                window.remove_css_class('notchline-theme-te');
        };
        refreshTheme();
        this._refreshers.push(refreshTheme);

        window.set_default_size(980, 820);
        window.width_request = 360;
        window.height_request = 480;
        // GNOME requires a page in the window's own stack before our layout replaces it
        window.add(new Adw.PreferencesPage());
        window.set_content(this._sidebarLayout(window, [
            this._generalPage(),
            this._widgetPage(),
            this._shelfPage(),
            this._agentPage(),
            this._shortcutPage(),
            this._aboutPage(),
        ]));
        window.connect('close-request', () => {
            this._flushSave();
            Gtk.StyleContext.remove_provider_for_display(window.get_display(), css);
            return false;
        });
    }

    // Sidebar on the left, the selected page on the right, like the design; on a narrow
    // window the sidebar becomes the first screen
    _sidebarLayout(window, pages) {
        const list = new Gtk.ListBox({css_classes: ['navigation-sidebar']});
        for (const page of pages) {
            const box = new Gtk.Box({spacing: 12, margin_start: 6, margin_end: 6, margin_top: 6, margin_bottom: 6});
            box.append(new Gtk.Image({icon_name: page.icon_name}));
            box.append(new Gtk.Label({label: page.title, xalign: 0}));
            list.append(new Gtk.ListBoxRow({child: box}));
        }

        const sidebarHeader = new Adw.HeaderBar({show_title: true});
        sidebarHeader.title_widget = new Adw.WindowTitle({title: 'Notchline'});
        const sidebarView = new Adw.ToolbarView({content: new Gtk.ScrolledWindow({
            child: list,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
        })});
        sidebarView.add_top_bar(sidebarHeader);

        const contentTitle = new Adw.WindowTitle();
        const contentHeader = new Adw.HeaderBar();
        contentHeader.title_widget = contentTitle;
        const contentView = new Adw.ToolbarView();
        contentView.add_top_bar(contentHeader);

        const split = new Adw.NavigationSplitView({
            sidebar: new Adw.NavigationPage({title: 'Notchline', child: sidebarView}),
            content: new Adw.NavigationPage({title: pages[0].title, child: contentView}),
            min_sidebar_width: 200,
            max_sidebar_width: 240,
        });

        list.connect('row-activated', (_list, row) => {
            const page = pages[row.get_index()];
            contentView.content = page;
            contentTitle.title = page.title;
            split.content.title = page.title;
            split.show_content = true;
        });
        list.select_row(list.get_row_at_index(0));
        contentView.content = pages[0];
        contentTitle.title = pages[0].title;

        const breakpoint = new Adw.Breakpoint({condition: Adw.BreakpointCondition.parse('max-width: 600sp')});
        breakpoint.add_setter(split, 'collapsed', true);
        window.add_breakpoint(breakpoint);
        return split;
    }

    // Config access and saving

    _get(path) {
        return path.reduce((node, key) => node?.[key], this._config);
    }

    _set(path, value) {
        if (this._syncing)
            return;
        let node = this._config;
        for (const key of path.slice(0, -1))
            node = node[key] ??= {};
        node[path.at(-1)] = value;
        this._queueSave();
    }

    _queueSave() {
        if (this._saveId)
            GLib.source_remove(this._saveId);
        this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_DELAY_MS, () => {
            this._saveId = 0;
            this._save();
            return GLib.SOURCE_REMOVE;
        });
    }

    _flushSave() {
        if (this._saveId) {
            GLib.source_remove(this._saveId);
            this._saveId = 0;
            this._save();
        }
    }

    _save() {
        if (!this._proxy)
            return;
        this._proxy.SetConfigRemote(JSON.stringify(this._config), (_result, error) => {
            if (error)
                console.warn(`Notchline: saving config failed: ${error.message}`);
        });
    }

    // The daemon answers every save (or a `notchline reload`) with the effective config
    _reload() {
        if (this._saveId)
            return;
        try {
            this._config = JSON.parse(this._proxy.Config || '{}');
        } catch (e) {
            return;
        }
        this._syncing = true;
        this._refreshers.forEach(refresh => refresh());
        this._syncing = false;
    }

    // Row builders bound to a config path

    _switchRow(group, path, title, subtitle = '') {
        const row = new Adw.SwitchRow({title, subtitle});
        const refresh = () => {
            row.active = !!this._get(path);
        };
        refresh();
        this._refreshers.push(refresh);
        row.connect('notify::active', () => this._set(path, row.active));
        group.add(row);
        return row;
    }

    _spinRow(group, path, title, subtitle, {lower, upper, step = 1, digits = 0}) {
        const row = Adw.SpinRow.new_with_range(lower, upper, step);
        row.title = title;
        row.subtitle = subtitle;
        row.digits = digits;
        const refresh = () => {
            row.value = this._get(path) ?? lower;
        };
        refresh();
        this._refreshers.push(refresh);
        row.connect('notify::value', () => {
            const value = digits === 0 ? Math.round(row.value) : Number(row.value.toFixed(digits));
            this._set(path, value);
        });
        group.add(row);
        return row;
    }

    _colorRow(group, path, title, subtitle) {
        const row = new Adw.ActionRow({title, subtitle});
        const button = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({with_alpha: false}),
            valign: Gtk.Align.CENTER,
        });
        const refresh = () => {
            button.rgba = hexToRgba(this._get(path));
        };
        refresh();
        this._refreshers.push(refresh);
        button.connect('notify::rgba', () => this._set(path, rgbaToHex(button.rgba)));
        row.add_suffix(button);
        group.add(row);
        return row;
    }

    // Radio rows for a string option; options are [value, title, subtitle, enabled]
    _choiceRows(group, path, options, onChange = null) {
        let first = null;
        const checks = [];
        for (const [value, title, subtitle, enabled = true] of options) {
            const row = new Adw.ActionRow({title, subtitle, sensitive: enabled});
            const check = new Gtk.CheckButton({valign: Gtk.Align.CENTER, group: first});
            first ??= check;
            row.add_prefix(check);
            row.activatable_widget = check;
            group.add(row);
            checks.push([value, check]);
        }
        const refresh = () => {
            const current = this._get(path);
            checks.forEach(([value, check]) => {
                check.active = value === current;
            });
        };
        refresh();
        this._refreshers.push(refresh);
        // Connected after the first refresh so opening the window doesn't save
        checks.forEach(([value, check]) => check.connect('toggled', () => {
            if (!check.active)
                return;
            this._set(path, value);
            onChange?.(value);
        }));
    }

    // Descriptions are plain text; Adwaita would parse them as Pango markup
    _group(page, title, description = '') {
        const group = new Adw.PreferencesGroup({title, description: GLib.markup_escape_text(description, -1)});
        page.add(group);
        return group;
    }

    // Pages

    _generalPage() {
        const page = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});

        if (this._error) {
            const group = this._group(page, 'Daemon not connected',
                `Settings can't be read or saved. Run notchline install-service, then reopen this window.\n${this._error}`);
            group.add_css_class('error');
        }

        const theme = this._group(page, 'Theme',
            'Colors of the notch, panel and this window. Choosing a theme also changes the notch color.');
        this._choiceRows(theme, ['pill', 'theme'], [
            ['default', 'Default', 'Black with a teal accent'],
            ['te', 'TE', 'Graphite with an orange accent'],
        ], value => {
            this._set(['pill', 'background'], THEME_NOTCH[value]);
            this._syncing = true;
            this._refreshers.forEach(refresh => refresh());
            this._syncing = false;
        });

        const style = this._group(page, 'Notch style',
            'Shape of the notch when it appears. Its content is the same in every style.');
        this._choiceRows(style, ['pill', 'style'], [
            ['menyatu', 'Merged', 'Grows out of the top screen edge with inward curved corners'],
            ['pulau', 'Floating island', 'A separate capsule below the top edge'],
            ['sayap', 'Wings', `Info on the left and right of the notch. ${COMING_SOON}`, false],
        ]);

        const display = this._group(page, 'Display');
        this._switchRow(display, ['pill', 'reveal_on_hover'], 'Show when the pointer moves up',
            'The notch stays hidden when idle and appears when the pointer touches the top center edge.');
        this._switchRow(display, ['pill', 'idle_visible'], 'Show when idle',
            'Used when "Show when the pointer moves up" is off.');
        this._spinRow(display, ['pill', 'idle_width'], 'Idle notch width', 'Pixels. The compact status expands from this size.',
            {lower: 80, upper: 600});
        this._spinRow(display, ['pill', 'idle_height'], 'Notch height', 'Pixels.', {lower: 16, upper: 80});
        this._spinRow(display, ['pill', 'expanded_width'], 'Expanded notification width', 'Pixels, when the notch is expanded.',
            {lower: 200, upper: 1000});
        this._spinRow(display, ['pill', 'expanded_height'], 'Minimum expanded notification height', 'Pixels.',
            {lower: 32, upper: 400});
        this._spinRow(display, ['pill', 'panel_width'], 'Panel width', 'Pixels, for the panel that opens when the notch is hovered or pulled.',
            {lower: 400, upper: 1600, step: 10});
        this._spinRow(display, ['pill', 'radius'], 'Corner radius', 'Pixels, limited to half the notch height.',
            {lower: 0, upper: 60});
        this._spinRow(display, ['pill', 'top_offset'], 'Top offset', 'Pixels, only for the Floating island style.',
            {lower: 0, upper: 60});
        this._colorRow(display, ['pill', 'background'], 'Notch color', 'Black blends in with the screen bezel.');
        this._spinRow(display, ['pill', 'opacity'], 'Opacity', '0 to 1.',
            {lower: 0, upper: 1, step: 0.05, digits: 2});

        const behavior = this._group(page, 'Behavior');
        this._switchRow(behavior, ['behavior', 'show_indicator'], 'Top bar icon',
            'Quick access to open the panel, pause notch notifications and open settings.');
        this._switchRow(behavior, ['behavior', 'capture_system'], 'Show system notifications',
            'App notifications and notify-send appear in the notch.');
        this._switchRow(behavior, ['behavior', 'hide_gnome_banners'], 'Hide GNOME banners',
            'The default GNOME banners are hidden while a notification shows in the notch.');
        this._spinRow(behavior, ['behavior', 'timeout_ms'], 'Display time', 'Milliseconds per notification.',
            {lower: 1000, upper: 30000, step: 500});

        const system = this._group(page, 'System status', 'Compact states that appear in the notch on their own.');
        this._switchRow(system, ['system', 'charging_notice'], 'Charging',
            'Show the battery level for 3 seconds when the charger is plugged in.');
        this._switchRow(system, ['system', 'meeting_reminder'], 'Meeting starting soon',
            'Remind before an event in GNOME Calendar starts.');
        this._spinRow(system, ['system', 'meeting_minutes'], 'Remind before meeting', 'Minutes.',
            {lower: 1, upper: 30});
        this._spinRow(system, ['system', 'focus_minutes'], 'Focus timer length',
            'Minutes. Start it from the Notchline top bar icon menu, or with notchline focus.', {lower: 1, upper: 180});

        const drop = this._group(page, 'Drop',
            'A liquid drop that stretches toward the pointer near the top center edge. All sizes are in pixels.');
        this._switchRow(drop, ['drop', 'enabled'], 'Enable drop');
        this._spinRow(drop, ['drop', 'pull_range'], 'Pull distance', 'Pointer distance below the notch at which the drop starts to stretch.',
            {lower: 0, upper: 300});
        this._spinRow(drop, ['drop', 'max_depth'], 'Maximum length', 'How far the drop stretches.',
            {lower: 0, upper: 100});
        this._spinRow(drop, ['drop', 'min_width'], 'Minimum width', '', {lower: 1, upper: 50, step: 0.5, digits: 1});
        this._spinRow(drop, ['drop', 'max_width'], 'Maximum width', '', {lower: 1, upper: 80, step: 0.5, digits: 1});
        this._spinRow(drop, ['drop', 'blend'], 'Blend softness', 'How smoothly the drop merges with the notch.',
            {lower: 0, upper: 30, step: 0.5, digits: 1});

        const motion = this._group(page, 'Springs',
            'Every movement is driven by a spring. Higher stiffness is faster; lower damping wobbles more.');
        this._spinRow(motion, ['pill', 'animation_ms'], 'Animation speed',
            'Reference in milliseconds; 280 uses the spring values as they are, lower is faster.', {lower: 50, upper: 2000, step: 10});
        for (const [name, label] of [['width', 'Notch width'], ['height', 'Notch height'],
            ['drop', 'Drop length'], ['drop_x', 'Drop shift']]) {
            this._spinRow(motion, ['spring', `${name}_stiffness`], `${label} · stiffness`, '',
                {lower: 1, upper: 3000, step: 10});
            this._spinRow(motion, ['spring', `${name}_damping`], `${label} · damping`, '',
                {lower: 0, upper: 200, step: 1});
        }
        const reset = new Gtk.Button({label: 'Restore defaults', valign: Gtk.Align.CENTER});
        reset.connect('clicked', () => {
            this._config.drop = {};
            this._config.spring = {};
            this._config.pill.animation_ms = 280;
            // The daemon fills in the defaults and sends them back to the rows
            if (this._saveId) {
                GLib.source_remove(this._saveId);
                this._saveId = 0;
            }
            this._save();
        });
        motion.header_suffix = reset;

        return page;
    }

    // Pages for features that are not built yet: the design's rows, shown but disabled
    _comingSoonPage(title, icon, description, sections) {
        const page = new Adw.PreferencesPage({title, icon_name: icon});
        this._group(page, title, `${description}\n\n${COMING_SOON}`);
        for (const [groupTitle, rows] of sections) {
            const group = this._group(page, groupTitle);
            group.sensitive = false;
            for (const [rowTitle, subtitle, suffix] of rows) {
                const row = plainRow({title: rowTitle, subtitle});
                if (suffix === 'switch')
                    row.add_suffix(new Gtk.Switch({valign: Gtk.Align.CENTER}));
                else if (suffix)
                    row.add_suffix(new Gtk.Label({label: suffix, css_classes: ['dim-label']}));
                group.add(row);
            }
        }
        return page;
    }

    _widgetPage() {
        return this._comingSoonPage('Widget', 'view-grid-symbolic',
            'Choose the widgets shown in the notch panel and their order.', [
                ['Widgets in the panel', [
                    ['Music', 'Now playing and player controls (MPRIS)', 'switch'],
                    ['Calendar', 'Next event and time left until it starts', 'switch'],
                    ['File shelf', 'Files you drag to the notch', 'switch'],
                    ['AI agents', 'Claude Code and OpenCode progress', 'switch'],
                    ['Timer', 'Countdown and Pomodoro from the notch', 'switch'],
                    ['Device battery', 'Laptop and Bluetooth devices (UPower)', 'switch'],
                ]],
                ['Music', [
                    ['Player source', 'Follows the app that played last', 'Automatic'],
                    ['Colors follow album art', 'The progress line and visualizer use the cover colors', 'switch'],
                    ['Visualizer in the compact notch', 'Small bars move while a song plays', 'switch'],
                ]],
                ['Calendar', [
                    ['Calendars to read', 'Taken from the accounts in GNOME Calendar', 'All'],
                    ['Remind before meeting', 'The notch expands 5 minutes before', 'switch'],
                ]],
            ]);
    }

    _shelfPage() {
        return this._comingSoonPage('Shelf', 'folder-symbolic',
            'Drag files to the notch to hold them for a while, then drag them on to any app.', [
                ['Storage', [
                    ['Keep files for', 'After that, files are removed from the shelf', '24 hours'],
                    ['Shelf size limit', 'New files are rejected when the shelf is full', '2 GB'],
                    ['Copy files, don\'t move them', 'The original files stay where they are', 'switch'],
                    ['Open the shelf when a file is dragged to the notch', 'The notch expands as the pointer brings a file close', 'switch'],
                ]],
                ['Quick actions', [
                    ['Compress to ZIP', 'The result goes back to the shelf', 'switch'],
                    ['Copy file path', 'To paste into a terminal or an agent prompt', 'switch'],
                ]],
            ]);
    }

    _agentPage() {
        const page = new Adw.PreferencesPage({title: 'AI agents', icon_name: 'utilities-terminal-symbolic'});

        const sources = this._group(page, 'Sources',
            'Notchline reads events from the Claude Code hooks and the OpenCode plugin, then shows their progress in the notch. No data leaves this computer.');
        this._sourceRow(sources, 'Claude Code', 'Hook · ~/.claude/settings.json', 'claude',
            () => this._claudeHooksInstalled());
        this._sourceRow(sources, 'OpenCode', 'Plugin · ~/.config/opencode/plugins/notchline.ts', 'opencode',
            () => this._openCodePluginInstalled());

        const display = this._group(page, 'Show in the notch', 'Applies to all the sources above.');
        this._switchRow(display, ['agent', 'enabled'], 'Enable agents');
        this._switchRow(display, ['agent', 'show_progress'], 'Task progress',
            'Read the agent\'s todo list and show it as steps, for example 4/7.');
        this._switchRow(display, ['agent', 'permission_requests'], 'Permission requests',
            'The notch stays open on the Agents tab until you answer in the notch or in the terminal.');
        this._switchRow(display, ['agent', 'notify_done'], 'Notify when an agent finishes',
            'The notch expands for 4 seconds with the total working time.');
        this._switchRow(display, ['agent', 'allow_from_notch'], 'Allow from the notch',
            'The Allow once button only appears for commands on the safe list.');
        this._spinRow(display, ['agent', 'permission_timeout_s'], 'Permission timeout',
            'Seconds. After that, the terminal asks as usual.', {lower: 10, upper: 600, step: 5});

        const safe = this._group(page, 'Safe commands',
            'Only these commands (exactly, or followed by arguments) can be allowed from the notch. Commands containing ; & | ` $( > <, sudo, rm -rf, git push or curl are always asked in the terminal.');
        this._listRows(safe, ['agent', 'safe_commands'], 'Add a command, for example npm test');
        return page;
    }

    // Editable list of strings: an entry to add, and a row with a remove button per item
    _listRows(group, path, addTitle) {
        const rows = [];
        const refresh = () => {
            rows.forEach(row => group.remove(row));
            rows.length = 0;
            for (const item of this._get(path) ?? []) {
                const row = plainRow({title: item});
                row.add_css_class('monospace');
                const remove = new Gtk.Button({
                    icon_name: 'user-trash-symbolic',
                    valign: Gtk.Align.CENTER,
                    css_classes: ['flat'],
                    tooltip_text: 'Remove',
                });
                remove.connect('clicked', () => {
                    this._set(path, (this._get(path) ?? []).filter(value => value !== item));
                    refresh();
                });
                row.add_suffix(remove);
                group.add(row);
                rows.push(row);
            }
        };
        const entry = new Adw.EntryRow({title: addTitle, show_apply_button: true});
        entry.connect('apply', () => {
            const value = entry.text.trim();
            const list = this._get(path) ?? [];
            if (value && !list.includes(value))
                this._set(path, [...list, value]);
            entry.text = '';
            refresh();
        });
        group.add(entry);
        refresh();
        this._refreshers.push(refresh);
    }

    // An agent source with its state and an install / remove button
    _sourceRow(group, title, subtitle, agent, isInstalled) {
        const row = plainRow({title, subtitle});
        const state = new Gtk.Label({valign: Gtk.Align.CENTER, css_classes: ['dim-label']});
        const toggle = new Gtk.Button({valign: Gtk.Align.CENTER});
        const refresh = () => {
            const installed = isInstalled();
            state.label = installed ? 'Connected' : 'Not installed';
            toggle.label = installed ? 'Remove' : 'Install';
            toggle.css_classes = installed ? [] : ['suggested-action'];
        };
        toggle.connect('clicked', () => {
            toggle.sensitive = false;
            this._runNotchline([isInstalled() ? 'uninstall-hooks' : 'install-hooks', agent], error => {
                toggle.sensitive = true;
                refresh();
                if (error)
                    state.label = `Failed: ${error}`;
            });
        });
        refresh();
        row.add_suffix(state);
        row.add_suffix(toggle);
        group.add(row);
    }

    _openCodePluginInstalled() {
        const base = GLib.build_filenamev([GLib.get_user_config_dir(), 'opencode']);
        return ['plugins', 'plugin'].some(dir =>
            GLib.file_test(GLib.build_filenamev([base, dir, 'notchline.ts']), GLib.FileTest.EXISTS));
    }

    _claudeHooksInstalled() {
        const dir = GLib.getenv('CLAUDE_CONFIG_DIR') ?? GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
        try {
            const [, bytes] = GLib.file_get_contents(GLib.build_filenamev([dir, 'settings.json']));
            return new TextDecoder().decode(bytes).includes('notchline hook');
        } catch (e) {
            return false;
        }
    }

    // Run the notchline CLI (cargo installs it outside the desktop's PATH), then call done
    // with an error message or null
    _runNotchline(args, done) {
        const binary = GLib.find_program_in_path('notchline') ??
            GLib.build_filenamev([GLib.get_home_dir(), '.cargo', 'bin', 'notchline']);
        try {
            const process = Gio.Subprocess.new([binary, ...args],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
            process.communicate_utf8_async(null, null, (proc, result) => {
                try {
                    const [, output] = proc.communicate_utf8_finish(result);
                    done(proc.get_successful() ? null : output.trim());
                } catch (e) {
                    done(e.message);
                }
            });
        } catch (e) {
            done(e.message);
        }
    }

    _shortcutPage() {
        return this._comingSoonPage('Shortcuts', 'input-keyboard-symbolic',
            'Shortcuts work in all apps while Notchline is running.', [
                ['Notch', [
                    ['Open or close the panel', '', 'Super+Alt+N'],
                    ['Play or pause music', '', 'Super+Alt+P'],
                    ['Next track', '', 'Super+Alt+→'],
                    ['Pause all notch notifications', 'Not set', ''],
                ]],
                ['AI agents', [
                    ['Allow request', 'Only for commands on the safe list', 'Super+Alt+Y'],
                    ['Deny request', '', 'Super+Alt+X'],
                    ['View all agent sessions', '', 'Super+Alt+A'],
                ]],
            ]);
    }

    _aboutPage() {
        const page = new Adw.PreferencesPage({title: 'About', icon_name: 'help-about-symbolic'});

        const app = this._group(page, '');
        const brand = plainRow({
            title: 'Notchline',
            subtitle: `Version ${this.metadata['version-name'] ?? this.metadata.version ?? '?'}`,
        });
        brand.add_css_class('title-3');
        brand.add_prefix(new Gtk.Image({
            file: GLib.build_filenamev([this.path, 'icons', 'notchline-symbol.svg']),
            pixel_size: 48,
            margin_top: 6,
            margin_bottom: 6,
        }));
        app.add(brand);
        app.add(plainRow({
            title: 'Daemon',
            subtitle: this._error ? `Not connected: ${this._error}` : `Connected · ${BUS_NAME}`,
        }));

        const path = GLib.build_filenamev([GLib.get_user_config_dir(), 'notchline', 'config.toml']);
        const file = plainRow({title: 'Configuration file', subtitle: path, subtitle_selectable: true});
        const open = new Gtk.Button({label: 'Open in editor', valign: Gtk.Align.CENTER});
        open.connect('clicked', () => {
            this._flushSave();
            try {
                Gio.AppInfo.launch_default_for_uri(GLib.filename_to_uri(path, null), null);
            } catch (e) {
                console.warn(`Notchline: cannot open ${path}: ${e.message}`);
            }
        });
        file.add_suffix(open);
        app.add(file);

        const cli = this._group(page, 'From the terminal',
            'Changes on this page are saved to the configuration file right away. After editing the file by hand, run notchline reload.');
        for (const [command, description] of [
            ['notchline show "Title" "Body"', 'Show a notification'],
            ['notchline status --icon alarm-symbolic --text Focus --trail 24.59 --color warn', 'Show a compact status'],
            ['notchline config', 'Print the effective configuration'],
            ['notchline reload', 'Reload config.toml'],
        ]) {
            const row = plainRow({title: description, subtitle: command, subtitle_selectable: true});
            row.add_css_class('property');
            cli.add(row);
        }
        return page;
    }
}
