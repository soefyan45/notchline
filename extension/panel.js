import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {isAllDay} from './system.js';

// Full panel of the notch (Pego "Notch terbuka"): tabs, battery and settings on top,
// then the Home widgets. The shelf and agent tabs come in later phases.

export const CALENDAR_EVENTS = 2;
// Soon enough to count down "n mnt lagi" instead of showing the time range
export const SOON_MINUTES = 60;
export const TICK_SECONDS = 1;

export const pad = value => String(value).padStart(2, '0');

// m.ss, the way the design writes track times
export function formatTrackTime(microseconds) {
    const seconds = Math.max(Math.round(microseconds / 1e6), 0);
    return `${Math.floor(seconds / 60)}.${pad(seconds % 60)}`;
}

export const formatClock = date => `${pad(date.getHours())}.${pad(date.getMinutes())}`;

export function label(text, styleClass, props = {}) {
    const actor = new St.Label({text, style_class: styleClass, ...props});
    actor.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return actor;
}

export function icon(iconName, styleClass) {
    return new St.Icon({icon_name: iconName, style_class: styleClass, y_align: Clutter.ActorAlign.CENTER});
}

// A widget card: small header with icon and label, then the body
function card(iconName, title, props = {}) {
    const box = new St.BoxLayout({style_class: 'notchline-card', vertical: true, ...props});
    const header = new St.BoxLayout({style_class: 'notchline-card-header'});
    const titleLabel = label(title, 'notchline-card-title', {y_align: Clutter.ActorAlign.CENTER});
    header.add_child(icon(iconName, 'notchline-card-icon'));
    header.add_child(titleLabel);
    box.add_child(header);
    return {box, titleLabel};
}

// Album art drawn as a rounded background image, with the design's gradient as fallback
export function setArt(actor, artUrl) {
    const path = artUrl?.startsWith('file://') ? Gio.File.new_for_uri(artUrl).get_path() : null;
    if (path && GLib.file_test(path, GLib.FileTest.EXISTS)) {
        actor.style = `background-image: url("${path}"); background-size: cover;`;
        actor.remove_style_class_name('notchline-art-empty');
    } else {
        actor.style = null;
        actor.add_style_class_name('notchline-art-empty');
    }
}

// Next event starting within the hour, counted down instead of showing its time range
export function startsSoon(event, now) {
    const minutes = Math.round((event.date - now) / 60000);
    return !isAllDay(event) && minutes >= 0 && minutes <= SOON_MINUTES;
}

export function eventTime(event, now, soon) {
    if (isAllDay(event))
        return 'Sepanjang hari';
    if (event.date <= now)
        return `${formatClock(event.date)}-${formatClock(event.end)} · berlangsung`;
    if (soon)
        return `${formatClock(event.date)} · ${Math.round((event.date - now) / 60000)} mnt lagi`;
    return `${formatClock(event.date)}-${formatClock(event.end)}`;
}

export class NotchPanel {
    constructor(media, {battery, calendar, onSettings, onResize, agents}) {
        this._media = media;
        this._battery = battery;
        this._calendar = calendar;
        // Called when the panel's layout changes shape, not for every text update
        this._onResize = onResize;
        this._shape = null;
        this._active = false;
        this._tickId = 0;

        this.actor = new St.BoxLayout({style_class: 'notchline-panel', vertical: true, x_expand: true});
        this.actor.add_child(this._buildHeader(onSettings));

        this._pages = {
            home: this._buildHome(),
            shelf: this._emptyPage('folder-symbolic', 'Rak masih kosong',
                'Seret file ke notch untuk menyimpannya di sini. Segera hadir.'),
            agent: agents,
        };
        Object.values(this._pages).forEach(page => this.actor.add_child(page));
        this.showTab('home');

        media.connectObject('changed', () => this._updateMusic(), this);
        calendar.connectObject('changed', () => this._updateCalendar(), this);
        battery.connectObject('changed', () => this._updateBattery(), this);

        this._updateMusic();
        this._updateCalendar();
        this._updateBattery();
    }

    // Keep the clock-driven parts moving only while the panel is on screen
    setActive(active) {
        if (active === this._active)
            return;
        this._active = active;
        if (active) {
            this._media.current?.refreshPosition();
            this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TICK_SECONDS, () => {
                this._updateProgress();
                this._updateCalendar();
                return GLib.SOURCE_CONTINUE;
            });
            this._updateMusic();
            this._updateCalendar();
        } else if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
    }

    _buildHeader(onSettings) {
        const header = new St.BoxLayout({style_class: 'notchline-panel-header'});
        const tabs = new St.BoxLayout({style_class: 'notchline-tabs', x_expand: true});
        this._tabs = {};
        for (const [name, iconName, text] of [
            ['home', 'go-home-symbolic', 'Beranda'],
            ['shelf', 'folder-symbolic', 'Rak'],
            ['agent', 'utilities-terminal-symbolic', 'Agen'],
        ]) {
            const content = new St.BoxLayout({style_class: 'notchline-tab-content'});
            content.add_child(icon(iconName, 'notchline-tab-icon'));
            content.add_child(label(text, 'notchline-tab-label', {y_align: Clutter.ActorAlign.CENTER}));
            const tab = new St.Button({style_class: 'notchline-tab', child: content, can_focus: true});
            tab.connect('clicked', () => this.showTab(name));
            tabs.add_child(tab);
            this._tabs[name] = tab;
        }
        header.add_child(tabs);

        const status = new St.BoxLayout({style_class: 'notchline-panel-status'});
        this._batteryBox = new St.BoxLayout({style_class: 'notchline-battery', visible: false});
        this._batteryIcon = icon('battery-symbolic', 'notchline-battery-icon');
        this._batteryLabel = label('', 'notchline-battery-label notchline-mono', {y_align: Clutter.ActorAlign.CENTER});
        this._batteryBox.add_child(this._batteryIcon);
        this._batteryBox.add_child(this._batteryLabel);
        const settings = new St.Button({
            style_class: 'notchline-icon-button',
            child: icon('emblem-system-symbolic', 'notchline-settings-icon'),
            can_focus: true,
        });
        settings.connect('clicked', () => onSettings());
        status.add_child(this._batteryBox);
        status.add_child(settings);
        header.add_child(status);
        return header;
    }

    showTab(name) {
        for (const [tabName, tab] of Object.entries(this._tabs)) {
            if (tabName === name)
                tab.add_style_pseudo_class('checked');
            else
                tab.remove_style_pseudo_class('checked');
            this._pages[tabName].visible = tabName === name;
        }
        // Pages differ in height, so the notch has to fit the new one
        this._onResize();
    }

    _buildHome() {
        const row = new St.BoxLayout({style_class: 'notchline-widgets', x_expand: true});
        row.add_child(this._buildMusic());
        row.add_child(this._buildCalendar());
        row.add_child(this._buildShelf());
        return row;
    }

    _buildMusic() {
        const {box} = card('audio-x-generic-symbolic', 'Sedang diputar', {x_expand: true});
        const body = new St.BoxLayout({style_class: 'notchline-music', vertical: true});

        const song = new St.BoxLayout({style_class: 'notchline-song'});
        this._art = new St.Widget({style_class: 'notchline-art notchline-art-large'});
        const titles = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._songTitle = label('', 'notchline-song-title');
        this._songArtist = label('', 'notchline-song-artist');
        titles.add_child(this._songTitle);
        titles.add_child(this._songArtist);
        song.add_child(this._art);
        song.add_child(titles);

        const progress = new St.BoxLayout({style_class: 'notchline-progress-box', vertical: true});
        this._track = new St.Widget({style_class: 'notchline-progress', x_expand: true});
        this._played = new St.Widget({style_class: 'notchline-progress-fill'});
        this._track.add_child(this._played);
        this._track.connect('notify::width', () => this._updateProgress());
        const times = new St.BoxLayout();
        this._elapsed = label('', 'notchline-time notchline-mono', {x_expand: true});
        this._remaining = label('', 'notchline-time notchline-mono');
        times.add_child(this._elapsed);
        times.add_child(this._remaining);
        progress.add_child(this._track);
        progress.add_child(times);

        const controls = new St.BoxLayout({style_class: 'notchline-controls', x_align: Clutter.ActorAlign.CENTER});
        const button = (iconName, styleClass, action) => {
            const actor = new St.Button({style_class: styleClass, child: icon(iconName, 'notchline-media-icon'), can_focus: true});
            actor.connect('clicked', () => action(this._media.current));
            controls.add_child(actor);
            return actor;
        };
        this._prev = button('media-skip-backward-symbolic', 'notchline-media-button', player => player?.previous());
        this._playPause = button('media-playback-pause-symbolic', 'notchline-media-button notchline-media-main',
            player => player?.playPause());
        this._next = button('media-skip-forward-symbolic', 'notchline-media-button', player => player?.next());

        this._musicBody = [song, progress, controls];
        this._musicEmpty = label('Tidak ada musik yang diputar', 'notchline-empty-hint', {visible: false});
        [...this._musicBody, this._musicEmpty].forEach(actor => body.add_child(actor));
        box.add_child(body);
        return box;
    }

    _buildCalendar() {
        const {box} = card('x-office-calendar-symbolic', 'Kalender', {style_class: 'notchline-card notchline-card-side'});
        const body = new St.BoxLayout({style_class: 'notchline-calendar', vertical: true});
        const date = new St.BoxLayout({style_class: 'notchline-date'});
        this._day = label('', 'notchline-day');
        this._weekday = label('', 'notchline-weekday', {y_align: Clutter.ActorAlign.END});
        date.add_child(this._day);
        date.add_child(this._weekday);
        body.add_child(date);

        this._eventRows = [];
        for (let i = 0; i < CALENDAR_EVENTS; i++) {
            const row = new St.BoxLayout({style_class: 'notchline-event'});
            const marker = new St.Widget({style_class: 'notchline-event-marker', y_expand: true});
            const text = new St.BoxLayout({vertical: true, x_expand: true});
            const summary = label('', 'notchline-event-title');
            const time = label('', 'notchline-event-time notchline-mono');
            text.add_child(summary);
            text.add_child(time);
            row.add_child(marker);
            row.add_child(text);
            body.add_child(row);
            this._eventRows.push({row, marker, summary, time});
        }
        this._noEvents = label('Tidak ada acara lagi hari ini', 'notchline-empty-hint');
        body.add_child(this._noEvents);
        box.add_child(body);
        return box;
    }

    _buildShelf() {
        const {box} = card('folder-symbolic', 'Rak', {style_class: 'notchline-card notchline-card-side'});
        const hint = label('Seret file ke notch untuk menyimpannya di sini.', 'notchline-empty-hint');
        hint.clutter_text.line_wrap = true;
        hint.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        box.add_child(hint);
        return box;
    }

    _emptyPage(iconName, title, hint) {
        const page = new St.BoxLayout({style_class: 'notchline-empty-page', vertical: true, x_expand: true});
        page.add_child(new St.Icon({icon_name: iconName, style_class: 'notchline-empty-icon', x_align: Clutter.ActorAlign.CENTER}));
        page.add_child(label(title, 'notchline-empty-title', {x_align: Clutter.ActorAlign.CENTER}));
        const hintLabel = label(hint, 'notchline-empty-hint', {x_align: Clutter.ActorAlign.CENTER});
        hintLabel.clutter_text.line_wrap = true;
        hintLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        page.add_child(hintLabel);
        return page;
    }

    _updateMusic() {
        const player = this._media.current;
        this._musicBody.forEach(actor => {
            actor.visible = !!player;
        });
        this._musicEmpty.visible = !player;
        this._reshaped();
        if (!player)
            return;

        this._songTitle.text = player.title;
        this._songArtist.text = player.artist || player.identity;
        setArt(this._art, player.artUrl);
        this._playPause.child.icon_name = player.playing
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';
        this._prev.reactive = player.canGoPrevious;
        this._next.reactive = player.canGoNext;
        this._updateProgress();
    }

    _updateProgress() {
        const player = this._media.current;
        if (!player)
            return;
        const {position, length} = player;
        const fraction = length > 0 ? Math.min(position / length, 1) : 0;
        this._played.set_size(Math.round(this._track.width * fraction), this._track.height);
        this._elapsed.text = formatTrackTime(position);
        this._remaining.text = length > 0 ? `-${formatTrackTime(length - position)}` : '';
    }

    _updateCalendar() {
        const now = new Date();
        this._day.text = String(now.getDate());
        this._weekday.text = new Intl.DateTimeFormat(undefined, {weekday: 'long', month: 'short'}).format(now);

        const events = this._calendar.today()
            .filter(event => event.end > now)
            .slice(0, CALENDAR_EVENTS);

        this._eventRows.forEach(({row, marker, summary, time}, i) => {
            const event = events[i];
            row.visible = !!event;
            if (!event)
                return;
            const soon = i === 0 && startsSoon(event, now);
            summary.text = event.summary;
            time.text = eventTime(event, now, soon);
            // First event in accent, the next in warn, like the design
            marker.style_class = `notchline-event-marker ${i === 0 ? 'notchline-bg-accent' : 'notchline-bg-warn'}`;
            time.style_class = `notchline-event-time notchline-mono${soon ? ' notchline-accent' : ''}`;
        });
        this._noEvents.visible = events.length === 0;
        this._reshaped();
    }

    _reshaped() {
        const shape = `${this._musicEmpty.visible}|${this._eventRows.filter(r => r.row.visible).length}`;
        if (shape === this._shape)
            return;
        this._shape = shape;
        this._onResize();
    }

    _updateBattery() {
        const battery = this._battery;
        this._batteryBox.visible = battery.present;
        if (!battery.present)
            return;
        this._batteryLabel.text = `${battery.percentage}%`;
        this._batteryIcon.icon_name = battery.iconName;
        if (battery.charging)
            this._batteryIcon.add_style_class_name('notchline-success');
        else
            this._batteryIcon.remove_style_class_name('notchline-success');
    }

    destroy() {
        this.setActive(false);
        this._media.disconnectObject(this);
        this._calendar.disconnectObject(this);
        this._battery.disconnectObject(this);
        this.actor.destroy();
    }
}
