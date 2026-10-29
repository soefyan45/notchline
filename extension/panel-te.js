import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {agentName, sortSessions, terminalWindow, todoProgress} from './agents.js';
import {BatteryIcon, DotMatrix} from './dotmatrix.js';
import {
    CALENDAR_EVENTS, TICK_SECONDS, eventTime, formatTrackTime, icon, label, pad, setArt, startsSoon,
} from './panel.js';

// Full panel of the TE theme (Pego "Redesign · TE", "Notch terbuka" and "Panel Agen"):
// numbered keys on top, graphite widgets with black screens and dot-matrix readouts.
// Same interfaces as NotchPanel and AgentsPage.

const PROGRESS_SEGMENTS = 32;
const LOW_BATTERY = 20;
// Dot-matrix heights (logical px) of the design's Doto sizes 44, 32, 22 and 14
const DOTS_DAY = 30;
const DOTS_TIME = 22;
const DOTS_BATTERY = 15;
const DOTS_UNIT = 9;
// Agent readouts: the design's Doto sizes 48, 32 and 24
const DOTS_TASKS = 33;
const DOTS_DURATION = 22;
const DOTS_STEPS = 17;

const MAX_TODOS = 7;
const SIDE_CARDS = 2;
// Number of the first key on the agents page, after the three tabs
const FIRST_AGENT_KEY = 4;

// LED and caption of each session status
const AGENT_STATUS = {
    working: {led: 'notchline-te-led-blue', text: 'WORKING'},
    permission: {led: 'notchline-te-led-warn', text: 'NEEDS PERMISSION'},
    done: {led: 'notchline-te-led-on', text: 'DONE'},
    idle: {led: '', text: 'READY'},
};

const STEP_ICONS = {
    completed: 'object-select-symbolic',
    in_progress: 'process-working-symbolic',
    pending: 'radio-symbolic',
};

// Short letter-spaced text. Its measured width is rounded down, which would make Pango
// ellipsize the last letter, so it is never ellipsized.
export function caption(text, styleClass = 'notchline-te-caption', props = {}) {
    const actor = label(text, styleClass, props);
    actor.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return actor;
}

// A TE key: label at the top right, its number at the bottom left
export function key(text, number, styleClass = '', props = {}) {
    const cap = new St.BoxLayout({vertical: true, x_expand: true});
    cap.add_child(caption(text, 'notchline-te-key-label', {x_align: Clutter.ActorAlign.END}));
    cap.add_child(label(number, 'notchline-te-key-number', {y_expand: true, y_align: Clutter.ActorAlign.END}));
    return new St.Button({style_class: `notchline-te-key ${styleClass}`, child: cap, can_focus: true, ...props});
}

// A square TE key with an icon in place of the label
function iconKey(iconName, styleClass = '') {
    return new St.Button({
        style_class: `notchline-te-key notchline-te-key-square ${styleClass}`,
        child: new St.Icon({icon_name: iconName, style_class: 'notchline-te-key-icon'}),
        can_focus: true,
    });
}

// Black inset screen inside a widget
export function screen(props = {}) {
    return new St.BoxLayout({style_class: 'notchline-te-screen', ...props});
}

export function widget(text, props = {}) {
    const box = new St.BoxLayout({style_class: 'notchline-te-widget', vertical: true, ...props});
    const title = caption(text);
    box.add_child(title);
    return {box, title};
}

function wrapped(actor) {
    actor.clutter_text.line_wrap = true;
    actor.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return actor;
}

function led(styleClass = '') {
    return new St.Widget({style_class: `notchline-te-led ${styleClass}`, y_align: Clutter.ActorAlign.CENTER});
}

// A dot-matrix value with its unit in accent, bottoms aligned
function readout(value, unit, height) {
    const box = new St.BoxLayout({style_class: 'notchline-te-readout'});
    box.add_child(new DotMatrix('notchline-te-dots', height, value).actor);
    if (unit)
        box.add_child(new DotMatrix('notchline-te-dots notchline-te-dots-accent', DOTS_UNIT, unit).actor);
    return box;
}

// A full-width widget for a page with nothing to show yet
function emptyWidget(text, iconName, title, hint) {
    const {box} = widget(text, {x_expand: true});
    const display = screen({style_class: 'notchline-te-screen notchline-te-empty', vertical: true});
    display.add_child(new St.Icon({icon_name: iconName, style_class: 'notchline-te-empty-icon', x_align: Clutter.ActorAlign.CENTER}));
    display.add_child(label(title, 'notchline-te-song-title', {x_align: Clutter.ActorAlign.CENTER}));
    display.add_child(wrapped(label(hint, 'notchline-te-hint', {x_align: Clutter.ActorAlign.CENTER})));
    box.add_child(display);
    return box;
}

// m.ss below an hour, h.mm above, with the unit for the readout
function formatSpan(ms) {
    const minutes = Math.max(Math.round(ms / 1000), 0) / 60;
    if (minutes >= 60)
        return [`${Math.floor(minutes / 60)}.${pad(Math.floor(minutes % 60))}`, 'HR'];
    return [formatTrackTime(ms * 1000), 'MIN'];
}

export class TePanel {
    // Body padding [top, right, bottom, left] and corner radius of the open notch
    padding = [8, 8, 8, 8];
    radius = 20;

    constructor(media, {battery, calendar, onSettings, onResize, agents}) {
        this._media = media;
        this._battery = battery;
        this._calendar = calendar;
        this._onResize = onResize;
        this._shape = null;
        this._active = false;
        this._tickId = 0;

        this.actor = new St.BoxLayout({style_class: 'notchline-te-panel', vertical: true, x_expand: true});
        this.actor.add_child(this._buildHeader(onSettings));

        this._pages = {
            home: this._buildHome(),
            shelf: emptyWidget('01  SHELF', 'folder-symbolic', 'the shelf is empty',
                'drop files on the notch to keep them here. coming soon.'),
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
        const header = new St.BoxLayout({style_class: 'notchline-te-header'});
        const tabs = new St.BoxLayout({style_class: 'notchline-te-tabs', x_expand: true});
        this._tabs = {};
        for (const [name, text, number] of [
            ['home', 'HOME', '01'],
            ['shelf', 'SHELF', '02'],
            ['agent', 'AGENTS', '03'],
        ]) {
            const tab = key(text, number, 'notchline-te-tab');
            tab.connect('clicked', () => this.showTab(name));
            tabs.add_child(tab);
            this._tabs[name] = tab;
        }
        header.add_child(tabs);

        const status = new St.BoxLayout({style_class: 'notchline-te-status'});
        this._batteryBox = new St.BoxLayout({style_class: 'notchline-te-battery', visible: false});
        this._batteryIcon = new BatteryIcon('notchline-te-battery-icon');
        this._batteryValue = new DotMatrix('notchline-te-dots', DOTS_BATTERY);
        const readout = new St.BoxLayout({style_class: 'notchline-te-readout', y_align: Clutter.ActorAlign.CENTER});
        readout.add_child(this._batteryValue.actor);
        readout.add_child(new DotMatrix('notchline-te-dots notchline-te-dots-accent', DOTS_UNIT, '%').actor);
        this._batteryBox.add_child(this._batteryIcon.actor);
        this._batteryBox.add_child(readout);
        const settings = iconKey('emblem-system-symbolic');
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
        const row = new St.BoxLayout({style_class: 'notchline-te-widgets', x_expand: true});
        row.add_child(this._buildMusic());
        row.add_child(this._buildCalendar());
        row.add_child(this._buildShelf());
        return row;
    }

    _buildMusic() {
        const {box} = widget('01  NOW PLAYING', {x_expand: true});
        const display = screen({vertical: true});

        const song = new St.BoxLayout({style_class: 'notchline-te-song'});
        this._art = new St.Widget({style_class: 'notchline-art notchline-te-art', y_align: Clutter.ActorAlign.CENTER});
        const titles = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._songTitle = label('', 'notchline-te-song-title');
        this._songArtist = label('', 'notchline-te-song-artist');
        titles.add_child(this._songTitle);
        titles.add_child(this._songArtist);
        song.add_child(this._art);
        song.add_child(titles);
        song.add_child(caption('オンガク', 'notchline-te-caption notchline-te-accent', {y_align: Clutter.ActorAlign.CENTER}));

        const times = new St.BoxLayout();
        const readout = new St.BoxLayout({style_class: 'notchline-te-readout', x_expand: true});
        this._elapsed = new DotMatrix('notchline-te-dots', DOTS_TIME);
        this._length = new DotMatrix('notchline-te-dots notchline-te-dots-accent', DOTS_UNIT);
        readout.add_child(this._elapsed.actor);
        readout.add_child(this._length.actor);
        this._remaining = label('', 'notchline-te-hint', {y_align: Clutter.ActorAlign.END});
        times.add_child(readout);
        times.add_child(this._remaining);

        this._segments = [];
        const progress = new St.BoxLayout({style_class: 'notchline-te-progress', x_expand: true});
        for (let i = 0; i < PROGRESS_SEGMENTS; i++) {
            const segment = new St.Widget({style_class: 'notchline-te-segment', x_expand: true});
            progress.add_child(segment);
            this._segments.push(segment);
        }

        this._musicEmpty = label('nothing is playing', 'notchline-te-hint', {visible: false});
        this._musicScreen = [song, times, progress];
        [...this._musicScreen, this._musicEmpty].forEach(actor => display.add_child(actor));
        box.add_child(display);

        this._controls = new St.BoxLayout({style_class: 'notchline-te-controls'});
        this._prev = key('PREV', '05', 'notchline-te-key-media');
        this._prev.connect('clicked', () => this._media.current?.previous());
        this._playPause = new St.Button({
            style_class: 'notchline-te-play',
            child: icon('media-playback-pause-symbolic', 'notchline-te-play-icon'),
            can_focus: true,
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._playPause.connect('clicked', () => this._media.current?.playPause());
        this._next = key('NEXT', '06', 'notchline-te-key-media');
        this._next.connect('clicked', () => this._media.current?.next());
        [this._prev, this._playPause, this._next].forEach(actor => this._controls.add_child(actor));
        box.add_child(this._controls);
        return box;
    }

    _buildCalendar() {
        const {box} = widget('02  CALENDAR', {style_class: 'notchline-te-widget notchline-te-widget-side'});
        const display = screen();
        const date = new St.BoxLayout({style_class: 'notchline-te-readout', x_expand: true});
        this._day = new DotMatrix('notchline-te-dots', DOTS_DAY);
        this._month = new DotMatrix('notchline-te-dots notchline-te-dots-accent', DOTS_UNIT);
        date.add_child(this._day.actor);
        date.add_child(this._month.actor);
        this._weekday = label('', 'notchline-te-hint', {y_align: Clutter.ActorAlign.END});
        display.add_child(date);
        display.add_child(this._weekday);
        box.add_child(display);

        const events = new St.BoxLayout({style_class: 'notchline-te-events', vertical: true});
        this._eventRows = [];
        for (let i = 0; i < CALENDAR_EVENTS; i++) {
            const row = new St.BoxLayout({style_class: 'notchline-te-event'});
            const led = new St.Widget({style_class: 'notchline-te-led notchline-te-event-led'});
            const text = new St.BoxLayout({vertical: true, x_expand: true});
            const summary = label('', 'notchline-te-event-title');
            const time = label('', 'notchline-te-hint');
            text.add_child(summary);
            text.add_child(time);
            row.add_child(led);
            row.add_child(text);
            events.add_child(row);
            this._eventRows.push({row, led, summary, time});
        }
        this._noEvents = wrapped(label('no more events today', 'notchline-te-hint'));
        events.add_child(this._noEvents);
        box.add_child(events);
        return box;
    }

    _buildShelf() {
        const {box} = widget('03  SHELF', {style_class: 'notchline-te-widget notchline-te-widget-side'});
        box.add_child(wrapped(label('drop files on the notch to keep them here.',
            'notchline-te-hint notchline-te-note')));
        return box;
    }

    _updateMusic() {
        const player = this._media.current;
        this._musicScreen.forEach(actor => {
            actor.visible = !!player;
        });
        this._controls.visible = !!player;
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
        const lit = length > 0 ? Math.round(Math.min(position / length, 1) * PROGRESS_SEGMENTS) : 0;
        this._segments.forEach((segment, i) => {
            if (i < lit)
                segment.add_style_pseudo_class('checked');
            else
                segment.remove_style_pseudo_class('checked');
        });
        this._elapsed.text = formatTrackTime(position);
        this._length.text = length > 0 ? `/${formatTrackTime(length)}` : '';
        this._remaining.text = length > 0 ? `${formatTrackTime(length - position)} left` : '';
    }

    _updateCalendar() {
        const now = new Date();
        this._day.text = String(now.getDate());
        this._month.text = new Intl.DateTimeFormat('en-US', {month: 'short'}).format(now);
        this._weekday.text = new Intl.DateTimeFormat('en-US', {weekday: 'long'}).format(now).toLowerCase();

        const events = this._calendar.today()
            .filter(event => event.end > now)
            .slice(0, CALENDAR_EVENTS);

        this._eventRows.forEach(({row, led, summary, time}, i) => {
            const event = events[i];
            row.visible = !!event;
            if (!event)
                return;
            const soon = i === 0 && startsSoon(event, now);
            summary.text = event.summary;
            time.text = eventTime(event, now, soon);
            // The first event lights its LED, like the design
            if (i === 0)
                led.add_style_pseudo_class('checked');
            else
                led.remove_style_pseudo_class('checked');
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
        this._batteryValue.text = String(battery.percentage);
        this._batteryIcon.level = battery.percentage;
        const low = !battery.charging && battery.percentage <= LOW_BATTERY;
        this._batteryIcon.actor.style_class =
            `notchline-te-battery-icon${battery.charging ? ' notchline-te-charging' : low ? ' notchline-te-low' : ''}`;
    }

    destroy() {
        this.setActive(false);
        this._media.disconnectObject(this);
        this._calendar.disconnectObject(this);
        this._battery.disconnectObject(this);
        this.actor.destroy();
    }
}

export class TeAgentsPage {
    constructor({onAnswer, onSettings}) {
        this._onAnswer = onAnswer;

        this.actor = new St.BoxLayout({style_class: 'notchline-te-agents', vertical: true, x_expand: true});
        this._cards = new St.BoxLayout({style_class: 'notchline-te-widgets', x_expand: true});
        this._empty = emptyWidget('AGENTS', 'utilities-terminal-symbolic', 'no agent sessions yet',
            'set up claude code or opencode in settings · ai agents, then start a session in a terminal.');

        const footer = new St.BoxLayout({style_class: 'notchline-te-agents-footer'});
        this._count = label('', 'notchline-te-hint', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._settings = key('AGENT SOURCES', '', 'notchline-te-key-wide');
        this._settings.connect('clicked', () => onSettings());
        footer.add_child(this._count);
        footer.add_child(this._settings);

        this.actor.add_child(this._empty);
        this.actor.add_child(this._cards);
        this.actor.add_child(footer);
        this.setAgents([], {});
    }

    setAgents(sessions, config) {
        this._cards.destroy_all_children();
        this._nextKey = FIRST_AGENT_KEY;
        const sorted = sortSessions(sessions);
        this._empty.visible = sorted.length === 0;
        this._cards.visible = sorted.length > 0;
        const sources = [...new Set(sorted.map(agentName))].join(' and ').toLowerCase();
        this._count.text = sorted.length ? `${sorted.length} ${sorted.length === 1 ? 'session' : 'sessions'} · ${sources}` : '';

        // The first session gets the big card with its steps, the rest stack beside it
        const side = new St.BoxLayout({style_class: 'notchline-te-agent-side', vertical: true});
        sorted.forEach((session, i) => {
            if (i === 0)
                this._cards.add_child(this._card(session, i, true, config));
            else if (i <= SIDE_CARDS)
                side.add_child(this._card(session, i, false, config));
        });
        if (side.get_n_children())
            this._cards.add_child(side);
        this._settings.child.get_child_at_index(1).text = pad(this._nextKey);
    }

    // Keys are numbered in reading order across the page, like the design
    _key(text, styleClass, onClicked, props = {}) {
        const actor = key(text, pad(this._nextKey++), styleClass, props);
        actor.connect('clicked', () => onClicked());
        return actor;
    }

    _card(session, index, main, config) {
        const status = AGENT_STATUS[session.status] ?? AGENT_STATUS.idle;
        const {done, total} = todoProgress(session);
        const showProgress = config.show_progress !== false;
        const card = new St.BoxLayout({style_class: 'notchline-te-widget', vertical: true, x_expand: main});

        // Header: LED and numbered name with status, then where it runs
        const header = new St.BoxLayout({style_class: 'notchline-te-card-header'});
        const name = new St.BoxLayout({style_class: 'notchline-te-agent-name', x_expand: true});
        name.add_child(led(status.led));
        name.add_child(caption(`${pad(index + 1)}  ${agentName(session).toUpperCase()}  ·  ${status.text}`,
            'notchline-te-caption notchline-te-caption-bright', {y_align: Clutter.ActorAlign.CENTER}));
        const window = terminalWindow(session);
        const terminal = window ? Shell.WindowTracker.get_default().get_window_app(window)?.get_name() : null;
        header.add_child(name);
        header.add_child(label([session.project, terminal].filter(Boolean).join(' · '), 'notchline-te-hint',
            {y_align: Clutter.ActorAlign.CENTER}));
        card.add_child(header);

        const display = screen({vertical: true});
        card.add_child(display);
        const permission = session.status === 'permission' ? session.permission : null;
        if (permission) {
            display.add_child(wrapped(label(permission.detail || 'needs permission to continue',
                'notchline-te-agent-headline')));
            const row = new St.BoxLayout();
            row.add_child(label(permission.tool ?? '', 'notchline-te-hint notchline-te-command',
                {x_expand: true, y_align: Clutter.ActorAlign.END}));
            if (total && showProgress)
                row.add_child(readout(`${done}/${total}`, 'STEPS', DOTS_STEPS));
            display.add_child(row);
        } else if (session.status === 'done') {
            const row = new St.BoxLayout();
            const [value, unit] = session.finished_ms
                ? formatSpan(session.finished_ms - session.started_ms) : ['0.00', 'MIN'];
            const time = readout(value, unit, DOTS_DURATION);
            time.x_expand = true;
            row.add_child(time);
            row.add_child(label(total ? `${done} of ${total} tasks done` : 'done',
                'notchline-te-hint notchline-te-command', {y_align: Clutter.ActorAlign.END}));
            display.add_child(row);
        } else {
            const row = new St.BoxLayout();
            const current = session.todos?.find(todo => todo.status === 'in_progress');
            if (total && showProgress) {
                const tasks = readout(`${done}/${total}`, 'TASKS', DOTS_TASKS);
                tasks.x_expand = true;
                row.add_child(tasks);
            }
            const now = new St.BoxLayout({vertical: true, x_expand: !total, y_align: Clutter.ActorAlign.END});
            const align = total ? Clutter.ActorAlign.END : Clutter.ActorAlign.START;
            now.add_child(label(current?.content ?? session.tool ?? 'waiting', 'notchline-te-event-title', {x_align: align}));
            if (session.started_ms) {
                now.add_child(label(`running ${formatSpan(Date.now() - session.started_ms)[0]}`, 'notchline-te-hint',
                    {x_align: align}));
            }
            row.add_child(now);
            display.add_child(row);
            if (total && showProgress)
                display.add_child(this._segments(session.todos));
        }

        if (main && showProgress && session.status === 'working' && total) {
            const steps = new St.BoxLayout({style_class: 'notchline-te-steps', vertical: true});
            session.todos.slice(0, MAX_TODOS).forEach((todo, i) => {
                const row = new St.BoxLayout({style_class: `notchline-te-step notchline-te-step-${todo.status}`});
                row.add_child(label(pad(i + 1), 'notchline-te-step-number', {y_align: Clutter.ActorAlign.CENTER}));
                row.add_child(icon(STEP_ICONS[todo.status] ?? STEP_ICONS.pending, 'notchline-te-step-icon'));
                row.add_child(label(todo.content, 'notchline-te-step-text', {x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
                steps.add_child(row);
            });
            card.add_child(steps);
        }

        if (permission) {
            // Deny always works; allow only for safe commands; or hand back to the terminal
            const actions = new St.BoxLayout({style_class: 'notchline-te-actions'});
            actions.add_child(this._key('IN TERMINAL', '', () => this._onAnswer(permission.id, 'terminal'), {x_expand: true}));
            actions.add_child(this._key('DENY', '', () => this._onAnswer(permission.id, 'deny'), {x_expand: true}));
            if (permission.safe) {
                actions.add_child(this._key('ALLOW ONCE', 'notchline-te-key-accent',
                    () => this._onAnswer(permission.id, 'allow'), {x_expand: true}));
            }
            card.add_child(actions);
            return card;
        }

        // Footer: the current command, or the summary, and a way back to the terminal
        const footer = new St.BoxLayout({
            style_class: `notchline-te-card-footer${main && session.status === 'working' ? ' notchline-te-card-footer-line' : ''}`,
            y_expand: true,
            y_align: Clutter.ActorAlign.END,
        });
        const text = session.status === 'done' ? session.summary || 'summary ready to read' : session.tool;
        footer.add_child(label(text ?? '', 'notchline-te-hint notchline-te-command', {x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        if (window) {
            footer.add_child(this._key(session.status === 'done' ? 'READ' : 'OPEN TERMINAL',
                session.status === 'done' ? 'notchline-te-key-media' : 'notchline-te-key-wide',
                () => Main.activateWindow(window)));
        }
        card.add_child(footer);
        return card;
    }

    // One segment per todo: done lit, the running one in blue
    _segments(todos) {
        const bar = new St.BoxLayout({style_class: 'notchline-te-progress notchline-te-progress-wide', x_expand: true});
        for (const todo of todos) {
            const segment = new St.Widget({style_class: 'notchline-te-segment', x_expand: true});
            if (todo.status === 'completed')
                segment.add_style_pseudo_class('checked');
            else if (todo.status === 'in_progress')
                segment.add_style_class_name('notchline-te-segment-blue');
            bar.add_child(segment);
        }
        return bar;
    }

    destroy() {
        this.actor.destroy();
    }
}
