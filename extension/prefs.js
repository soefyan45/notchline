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
const COMING_SOON = 'Segera hadir: fitur ini dibuat di tahap berikutnya.';

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
    _choiceRows(group, path, options) {
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
            if (check.active)
                this._set(path, value);
        }));
    }

    _group(page, title, description = '') {
        const group = new Adw.PreferencesGroup({title, description});
        page.add(group);
        return group;
    }

    // Pages

    _generalPage() {
        const page = new Adw.PreferencesPage({title: 'Umum', icon_name: 'preferences-system-symbolic'});

        if (this._error) {
            const group = this._group(page, 'Daemon tidak terhubung',
                `Pengaturan tidak bisa dibaca atau disimpan. Jalankan notchline install-service, lalu buka lagi.\n${GLib.markup_escape_text(this._error, -1)}`);
            group.add_css_class('error');
        }

        const style = this._group(page, 'Gaya notch',
            'Bentuk notch saat muncul. Isi notch sama di semua gaya.');
        this._choiceRows(style, ['pill', 'style'], [
            ['menyatu', 'Menyatu', 'Tumbuh dari tepi atas layar dengan sudut melengkung ke dalam'],
            ['pulau', 'Pulau melayang', 'Kapsul terpisah di bawah tepi atas'],
            ['sayap', 'Sayap', `Info di kiri dan kanan notch. ${COMING_SOON}`, false],
        ]);

        const display = this._group(page, 'Tampilan');
        this._switchRow(display, ['pill', 'reveal_on_hover'], 'Muncul saat kursor ke atas',
            'Notch tersembunyi saat diam, lalu muncul saat kursor menyentuh tepi atas tengah.');
        this._switchRow(display, ['pill', 'idle_visible'], 'Tampil saat diam',
            'Dipakai saat "Muncul saat kursor ke atas" mati.');
        this._spinRow(display, ['pill', 'idle_width'], 'Lebar notch diam', 'Piksel. Status ringkas melebar dari ukuran ini.',
            {lower: 80, upper: 600});
        this._spinRow(display, ['pill', 'idle_height'], 'Tinggi notch', 'Piksel.', {lower: 16, upper: 80});
        this._spinRow(display, ['pill', 'expanded_width'], 'Lebar notifikasi penuh', 'Piksel, saat notch dibuka.',
            {lower: 200, upper: 1000});
        this._spinRow(display, ['pill', 'expanded_height'], 'Tinggi minimum notifikasi penuh', 'Piksel.',
            {lower: 32, upper: 400});
        this._spinRow(display, ['pill', 'radius'], 'Sudut', 'Piksel, dibatasi setengah tinggi notch.',
            {lower: 0, upper: 60});
        this._spinRow(display, ['pill', 'top_offset'], 'Jarak dari tepi atas', 'Piksel, hanya untuk gaya Pulau melayang.',
            {lower: 0, upper: 60});
        this._colorRow(display, ['pill', 'background'], 'Warna notch', 'Hitam menyatu dengan bezel layar.');
        this._spinRow(display, ['pill', 'opacity'], 'Opasitas', '0 sampai 1.',
            {lower: 0, upper: 1, step: 0.05, digits: 2});

        const behavior = this._group(page, 'Perilaku');
        this._switchRow(behavior, ['behavior', 'capture_system'], 'Tampilkan notifikasi sistem',
            'Notifikasi aplikasi dan notify-send muncul di notch.');
        this._switchRow(behavior, ['behavior', 'hide_gnome_banners'], 'Sembunyikan banner GNOME',
            'Banner bawaan GNOME tidak muncul saat notifikasi tampil di notch.');
        this._spinRow(behavior, ['behavior', 'timeout_ms'], 'Lama tampil', 'Milidetik per notifikasi.',
            {lower: 1000, upper: 30000, step: 500});

        const drop = this._group(page, 'Tetes',
            'Tetes cair yang menjulur ke arah kursor di dekat tepi atas tengah. Semua ukuran dalam piksel.');
        this._switchRow(drop, ['drop', 'enabled'], 'Aktifkan tetes');
        this._spinRow(drop, ['drop', 'pull_range'], 'Jarak tarik', 'Jarak kursor di bawah notch saat tetes mulai tertarik.',
            {lower: 0, upper: 300});
        this._spinRow(drop, ['drop', 'max_depth'], 'Panjang maksimum', 'Seberapa jauh tetes menjulur.',
            {lower: 0, upper: 100});
        this._spinRow(drop, ['drop', 'min_width'], 'Lebar minimum', '', {lower: 1, upper: 50, step: 0.5, digits: 1});
        this._spinRow(drop, ['drop', 'max_width'], 'Lebar maksimum', '', {lower: 1, upper: 80, step: 0.5, digits: 1});
        this._spinRow(drop, ['drop', 'blend'], 'Kelembutan sambungan', 'Seberapa halus tetes menyatu dengan notch.',
            {lower: 0, upper: 30, step: 0.5, digits: 1});

        const motion = this._group(page, 'Pegas',
            'Setiap gerakan digerakkan pegas. Stiffness makin besar makin cepat; damping makin kecil makin banyak goyang.');
        this._spinRow(motion, ['pill', 'animation_ms'], 'Kecepatan animasi',
            'Milidetik acuan; 280 memakai angka pegas apa adanya, lebih kecil lebih cepat.', {lower: 50, upper: 2000, step: 10});
        for (const [name, label] of [['width', 'Lebar notch'], ['height', 'Tinggi notch'],
            ['drop', 'Panjang tetes'], ['drop_x', 'Geser tetes']]) {
            this._spinRow(motion, ['spring', `${name}_stiffness`], `${label} · stiffness`, '',
                {lower: 1, upper: 3000, step: 10});
            this._spinRow(motion, ['spring', `${name}_damping`], `${label} · damping`, '',
                {lower: 0, upper: 200, step: 1});
        }
        const reset = new Gtk.Button({label: 'Kembalikan bawaan', valign: Gtk.Align.CENTER});
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
            'Pilih widget yang muncul di panel notch dan urutannya.', [
                ['Widget di panel', [
                    ['Musik', 'Lagu yang sedang diputar dan kontrol pemutar (MPRIS)', 'switch'],
                    ['Kalender', 'Acara berikutnya dan sisa waktu sebelum mulai', 'switch'],
                    ['Rak file', 'File yang kamu seret ke notch', 'switch'],
                    ['Agen AI', 'Progres Claude Code dan OpenCode', 'switch'],
                    ['Timer', 'Hitung mundur dan Pomodoro dari notch', 'switch'],
                    ['Baterai perangkat', 'Laptop dan perangkat Bluetooth (UPower)', 'switch'],
                ]],
                ['Musik', [
                    ['Sumber pemutar', 'Mengikuti aplikasi yang terakhir memutar', 'Otomatis'],
                    ['Warna mengikuti sampul album', 'Garis progres dan visualizer memakai warna sampul', 'switch'],
                    ['Visualizer di notch ringkas', 'Batang kecil bergerak selama lagu diputar', 'switch'],
                ]],
                ['Kalender', [
                    ['Kalender yang dibaca', 'Diambil dari akun di Kalender GNOME', 'Semua'],
                    ['Ingatkan sebelum rapat', 'Notch melebar 5 menit sebelumnya', 'switch'],
                ]],
            ]);
    }

    _shelfPage() {
        return this._comingSoonPage('Rak', 'folder-symbolic',
            'Seret file ke notch untuk menyimpannya sebentar, lalu seret lagi ke aplikasi mana pun.', [
                ['Penyimpanan', [
                    ['Simpan file selama', 'Setelah itu file dihapus dari rak', '24 jam'],
                    ['Batas ukuran rak', 'File baru ditolak jika rak penuh', '2 GB'],
                    ['Salin file, jangan pindahkan', 'File asli tetap di tempatnya', 'switch'],
                    ['Buka rak saat file diseret ke notch', 'Notch melebar saat kursor membawa file mendekat', 'switch'],
                ]],
                ['Aksi cepat', [
                    ['Kompres jadi ZIP', 'Hasilnya masuk lagi ke rak', 'switch'],
                    ['Salin jalur file', 'Untuk ditempel ke terminal atau prompt agen', 'switch'],
                ]],
            ]);
    }

    _agentPage() {
        return this._comingSoonPage('Agen AI', 'utilities-terminal-symbolic',
            'Notchline membaca kejadian dari agen coding di terminal, lalu menampilkan progresnya di notch.', [
                ['Sumber', [
                    ['Claude Code', 'Hook · ~/.claude/settings.json', 'Belum dipasang'],
                    ['OpenCode', 'Plugin · ~/.config/opencode/plugin/notchline.ts', 'Belum dipasang'],
                    ['Perintah lain di terminal', 'notchline run -- <perintah>', 'Belum dipakai'],
                ]],
                ['Tampilkan di notch', [
                    ['Progres tugas', 'Daftar todo agen sebagai langkah, misalnya 4/7', 'switch'],
                    ['Permintaan izin', 'Notch melebar sampai kamu menjawab', 'switch'],
                    ['Beri tahu saat agen selesai', 'Notch melebar 4 detik dengan total durasi', 'switch'],
                    ['Izinkan dari notch', 'Tombol Izinkan hanya untuk perintah aman', 'switch'],
                    ['Bunyi saat butuh izin', 'Bunyi pendek supaya tidak perlu terus melihat layar', 'switch'],
                ]],
            ]);
    }

    _shortcutPage() {
        return this._comingSoonPage('Pintasan', 'input-keyboard-symbolic',
            'Pintasan berlaku di semua aplikasi selama Notchline berjalan.', [
                ['Notch', [
                    ['Buka atau tutup panel', '', 'Super+Alt+N'],
                    ['Putar atau jeda musik', '', 'Super+Alt+P'],
                    ['Lagu berikutnya', '', 'Super+Alt+→'],
                    ['Jeda semua notifikasi notch', 'Belum diatur', ''],
                ]],
                ['Agen AI', [
                    ['Izinkan permintaan', 'Hanya untuk perintah di daftar aman', 'Super+Alt+Y'],
                    ['Tolak permintaan', '', 'Super+Alt+X'],
                    ['Lihat semua sesi agen', '', 'Super+Alt+A'],
                ]],
            ]);
    }

    _aboutPage() {
        const page = new Adw.PreferencesPage({title: 'Tentang', icon_name: 'help-about-symbolic'});

        const app = this._group(page, '');
        const brand = plainRow({
            title: 'Notchline',
            subtitle: `Versi ${this.metadata['version-name'] ?? this.metadata.version ?? '?'}`,
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
            subtitle: this._error ? `Tidak terhubung: ${this._error}` : `Terhubung · ${BUS_NAME}`,
        }));

        const path = GLib.build_filenamev([GLib.get_user_config_dir(), 'notchline', 'config.toml']);
        const file = plainRow({title: 'File konfigurasi', subtitle: path, subtitle_selectable: true});
        const open = new Gtk.Button({label: 'Buka di editor', valign: Gtk.Align.CENTER});
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

        const cli = this._group(page, 'Dari terminal',
            'Perubahan di halaman ini langsung disimpan ke file konfigurasi. Setelah mengubah file dengan tangan, jalankan notchline reload.');
        for (const [command, description] of [
            ['notchline show "Judul" "Isi"', 'Tampilkan notifikasi'],
            ['notchline status --icon alarm-symbolic --text Fokus --trail 24.59 --color warn', 'Tampilkan status ringkas'],
            ['notchline config', 'Cetak konfigurasi yang berlaku'],
            ['notchline reload', 'Muat ulang config.toml'],
        ]) {
            const row = plainRow({title: description, subtitle: command, subtitle_selectable: true});
            row.add_css_class('property');
            cli.add(row);
        }
        return page;
    }
}
