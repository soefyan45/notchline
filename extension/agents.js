import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// Coding agent sessions (Pego "Panel Agen"), fed by the daemon from the agents' hooks

const AGENT_NAMES = {claude: 'Claude Code', opencode: 'OpenCode'};
const MAX_TODOS = 7;
const SIDE_CARDS = 3;

// Look of each session status: tile icon, color token, and badge text
const STATUS = {
    working: {icon: 'utilities-terminal-symbolic', color: 'accent', badge: 'Bekerja'},
    permission: {icon: 'security-medium-symbolic', color: 'warn', badge: 'Butuh izin'},
    done: {icon: 'object-select-symbolic', color: 'success', badge: 'Selesai'},
    idle: {icon: 'utilities-terminal-symbolic', color: 'muted', badge: 'Siap'},
};
// Which sessions come first: the ones that need the user, then the busy ones
const STATUS_ORDER = ['permission', 'working', 'done', 'idle'];

const TODO_ICONS = {
    completed: ['object-select-symbolic', 'notchline-success'],
    in_progress: ['process-working-symbolic', 'notchline-accent'],
    pending: ['radio-symbolic', 'notchline-muted'],
};

export const agentName = session => AGENT_NAMES[session.source] ?? session.source;

// 6m 41d, the way the design writes durations (d = detik)
export function formatDuration(ms) {
    const seconds = Math.max(Math.round(ms / 1000), 0);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds % 3600 / 60);
    if (hours)
        return `${hours}j ${minutes}m`;
    return minutes ? `${minutes}m ${seconds % 60}d` : `${seconds % 60}d`;
}

export function todoProgress(session) {
    const total = session.todos?.length ?? 0;
    const done = session.todos?.filter(todo => todo.status === 'completed').length ?? 0;
    return {done, total};
}

// The agent's terminal: the first window owned by one of the hook's parent processes
export function terminalWindow(session) {
    const pids = new Set(session.pids ?? []);
    if (!pids.size)
        return null;
    return global.get_window_actors()
        .map(actor => actor.meta_window)
        .find(window => pids.has(window.get_pid())) ?? null;
}

export function sortSessions(sessions) {
    return [...sessions].sort((a, b) =>
        STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || b.updated_ms - a.updated_ms);
}

function label(text, styleClass, props = {}) {
    const actor = new St.Label({text: text ?? '', style_class: styleClass, ...props});
    actor.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return actor;
}

function icon(iconName, styleClass) {
    return new St.Icon({icon_name: iconName, style_class: styleClass, y_align: Clutter.ActorAlign.CENTER});
}

function button(text, styleClass, onClicked) {
    const actor = new St.Button({label: text, style_class: styleClass, can_focus: true});
    actor.connect('clicked', () => onClicked());
    return actor;
}

export class AgentsPage {
    constructor({onAnswer, onSettings}) {
        this._onAnswer = onAnswer;

        this.actor = new St.BoxLayout({style_class: 'notchline-agents', vertical: true, x_expand: true});
        this._cards = new St.BoxLayout({style_class: 'notchline-agent-cards', x_expand: true});

        this._empty = new St.BoxLayout({style_class: 'notchline-empty-page', vertical: true, x_expand: true});
        this._empty.add_child(new St.Icon({
            icon_name: 'utilities-terminal-symbolic',
            style_class: 'notchline-empty-icon',
            x_align: Clutter.ActorAlign.CENTER,
        }));
        this._empty.add_child(label('Belum ada sesi agen', 'notchline-empty-title', {x_align: Clutter.ActorAlign.CENTER}));
        this._empty.add_child(label('Pasang hook Claude Code di Pengaturan · Agen AI, lalu mulai sesi di terminal.',
            'notchline-empty-hint', {x_align: Clutter.ActorAlign.CENTER}));

        const footer = new St.BoxLayout({style_class: 'notchline-agents-footer'});
        this._count = label('', 'notchline-agents-count', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const settingsContent = new St.BoxLayout({style_class: 'notchline-tab-content'});
        settingsContent.add_child(icon('emblem-system-symbolic', 'notchline-tab-icon'));
        settingsContent.add_child(label('Atur sumber agen', 'notchline-agents-settings', {y_align: Clutter.ActorAlign.CENTER}));
        const settings = new St.Button({style_class: 'notchline-icon-button', child: settingsContent, can_focus: true});
        settings.connect('clicked', () => onSettings());
        footer.add_child(this._count);
        footer.add_child(settings);

        this.actor.add_child(this._empty);
        this.actor.add_child(this._cards);
        this.actor.add_child(footer);
        this.setAgents([], {});
    }

    setAgents(sessions, config) {
        this._cards.destroy_all_children();
        const side = new St.BoxLayout({style_class: 'notchline-agent-side-column', vertical: true});
        const sorted = sortSessions(sessions);
        this._empty.visible = sorted.length === 0;
        this._cards.visible = sorted.length > 0;
        this._count.text = sorted.length ? `${sorted.length} sesi · dari hook Claude Code` : '';

        // The first session gets the big card with its todo list, the rest stack beside it
        sorted.forEach((session, i) => {
            if (i === 0)
                this._cards.add_child(this._card(session, true, config));
            else if (i <= SIDE_CARDS)
                side.add_child(this._card(session, false, config));
        });
        if (side.get_n_children())
            this._cards.add_child(side);
    }

    _card(session, main, config) {
        const status = STATUS[session.status] ?? STATUS.idle;
        const {done, total} = todoProgress(session);
        const showProgress = config.show_progress !== false;
        const card = new St.BoxLayout({
            style_class: `notchline-card notchline-agent-card${main ? '' : ' notchline-agent-side'}`,
            vertical: true,
            x_expand: main,
        });

        // Header: status tile, agent and where it runs, then progress or a badge
        const header = new St.BoxLayout({style_class: 'notchline-agent-header'});
        header.add_child(new St.Bin({
            style_class: 'notchline-agent-tile',
            child: icon(status.icon, `notchline-agent-tile-icon notchline-${status.color}`),
        }));
        const titles = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const window = terminalWindow(session);
        const terminal = window ? Shell.WindowTracker.get_default().get_window_app(window)?.get_name() : null;
        titles.add_child(label(agentName(session), 'notchline-agent-name'));
        titles.add_child(label([session.project, terminal].filter(Boolean).join(' · '), 'notchline-agent-sub'));
        header.add_child(titles);
        if (session.status === 'working' && total && showProgress) {
            const count = new St.BoxLayout({style_class: 'notchline-agent-count', y_align: Clutter.ActorAlign.CENTER});
            count.add_child(label(`${done}/${total}`, 'notchline-agent-count-value'));
            count.add_child(label('tugas', 'notchline-agent-count-unit', {y_align: Clutter.ActorAlign.END}));
            header.add_child(count);
        } else {
            const badge = new St.BoxLayout({style_class: 'notchline-badge', y_align: Clutter.ActorAlign.CENTER});
            badge.add_child(new St.Widget({style_class: `notchline-badge-dot notchline-bg-${status.color}`, y_align: Clutter.ActorAlign.CENTER}));
            badge.add_child(label(status.badge, 'notchline-badge-label'));
            header.add_child(badge);
        }
        card.add_child(header);

        let headline = null;
        if (session.status === 'permission')
            headline = session.permission?.detail || 'Butuh izin untuk melanjutkan';
        else if (session.status === 'done')
            headline = session.summary || (total ? `${done} dari ${total} tugas selesai` : 'Selesai');
        if (headline)
            card.add_child(label(headline, 'notchline-agent-headline'));

        if ((total && showProgress) || session.status === 'done') {
            const track = new St.Widget({style_class: 'notchline-progress', x_expand: true});
            const fill = new St.Widget({style_class: `notchline-progress-fill notchline-bg-${status.color}`});
            track.add_child(fill);
            const fraction = session.status === 'done' ? 1 : done / total;
            track.connect('notify::width', () => fill.set_size(Math.round(track.width * fraction), track.height));
            card.add_child(track);
        }

        if (main && showProgress && session.status !== 'done' && total) {
            const list = new St.BoxLayout({style_class: 'notchline-todos', vertical: true});
            for (const todo of session.todos.slice(0, MAX_TODOS)) {
                const [iconName, color] = TODO_ICONS[todo.status] ?? TODO_ICONS.pending;
                const row = new St.BoxLayout({style_class: 'notchline-todo'});
                row.add_child(icon(iconName, `notchline-todo-icon ${color}`));
                row.add_child(label(todo.content, `notchline-todo-label notchline-todo-${todo.status}`, {x_expand: true}));
                list.add_child(row);
            }
            card.add_child(list);
        }

        // Footer: the current step (or how long it took), and a way back to the terminal
        const footer = new St.BoxLayout({style_class: 'notchline-agent-footer'});
        let step = session.tool;
        if (session.status === 'permission')
            step = session.permission?.tool ?? '';
        else if (session.status === 'done' && session.finished_ms)
            step = `Selesai dalam ${formatDuration(session.finished_ms - session.started_ms)}`;
        footer.add_child(label(step, 'notchline-agent-step notchline-mono', {x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        if (window)
            footer.add_child(button('Buka terminal', 'notchline-link', () => Main.activateWindow(window)));
        card.add_child(footer);

        // Permission: deny always works; allow only for safe commands; or hand back to the terminal
        const permission = session.status === 'permission' ? session.permission : null;
        if (permission) {
            const actions = new St.BoxLayout({style_class: 'notchline-agent-actions', x_align: Clutter.ActorAlign.END});
            actions.add_child(button('Di terminal', 'notchline-button', () => this._onAnswer(permission.id, 'terminal')));
            actions.add_child(button('Tolak', 'notchline-button', () => this._onAnswer(permission.id, 'deny')));
            if (permission.safe) {
                actions.add_child(button('Izinkan sekali', 'notchline-button notchline-button-accent',
                    () => this._onAnswer(permission.id, 'allow')));
            }
            card.add_child(actions);
        }
        return card;
    }

    destroy() {
        this.actor.destroy();
    }
}
