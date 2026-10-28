import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Extension, InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

const BUS_NAME = 'io.github.soefyan45.Notchline';
const OBJECT_PATH = '/io/github/soefyan45/Notchline';

const NotchlineIface = `
<node>
  <interface name="io.github.soefyan45.Notchline">
    <method name="Show">
      <arg type="s" name="title" direction="in"/>
      <arg type="s" name="body" direction="in"/>
      <arg type="s" name="icon" direction="in"/>
      <arg type="u" name="timeout_ms" direction="in"/>
      <arg type="u" direction="out"/>
    </method>
    <method name="Dismiss">
      <arg type="u" name="id" direction="in"/>
    </method>
    <method name="Reload"/>
    <property name="Config" type="s" access="read"/>
    <signal name="ShowRequested">
      <arg type="u" name="id"/>
      <arg type="s" name="title"/>
      <arg type="s" name="body"/>
      <arg type="s" name="icon"/>
      <arg type="u" name="timeout_ms"/>
    </signal>
    <signal name="DismissRequested">
      <arg type="u" name="id"/>
    </signal>
  </interface>
</node>`;

const NotchlineProxy = Gio.DBusProxy.makeProxyWrapper(NotchlineIface);

// Mirrors the Rust defaults; used until the daemon answers
const DEFAULT_CONFIG = {
    pill: {
        idle_visible: true,
        reveal_on_hover: true,
        idle_width: 160,
        idle_height: 30,
        expanded_width: 420,
        expanded_height: 72,
        top_offset: 4,
        radius: 18,
        background: '#000000',
        opacity: 0.95,
        animation_ms: 280,
    },
    behavior: {
        timeout_ms: 4000,
        hide_gnome_banners: true,
        capture_system: true,
    },
};

const HOVER_RECHECK_MS = 500;
const CONTENT_FADE_MS = 120;
// Height of the invisible strip on the top edge that reveals the idle notch
const HOT_ZONE_HEIGHT = 2;
// Grace period before hiding, so moving from the strip onto the notch doesn't flicker
const REVEAL_HIDE_DELAY_MS = 300;
// Pointer travel before a press on the notch turns into a pull
const DRAG_THRESHOLD = 8;
// Minimum pull distance between closed and open, for short notifications
const MIN_PULL_RANGE = 80;
// Fraction of the pull needed to open, and to stay open when pushed back up
const PULL_OPEN_THRESHOLD = 0.3;
const PULL_CLOSE_THRESHOLD = 0.7;
// Tallest the pulled-open notch may get, as a fraction of the monitor height
const FULL_MAX_HEIGHT = 0.6;

function mergeConfig(json) {
    let parsed = {};
    try {
        parsed = json ? JSON.parse(json) : {};
    } catch (e) {
        console.warn(`Notchline: invalid config from daemon: ${e}`);
    }
    return {
        pill: {...DEFAULT_CONFIG.pill, ...parsed.pill},
        behavior: {...DEFAULT_CONFIG.behavior, ...parsed.behavior},
    };
}

function hexToRgba(hex, alpha) {
    const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? '');
    const [r, g, b] = match ? match.slice(1).map(v => parseInt(v, 16)) : [0, 0, 0];
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

class Pill {
    constructor(config, {onClick, onPull}) {
        this._config = config;
        this._onClick = onClick;
        this._onPull = onPull;
        this.expanded = false;
        this.open = false;
        this._collapsing = false;
        this._revealed = false;
        this._revealTimeoutId = 0;
        this._shownMode = null;
        this._drag = null;
        this._grab = null;
        this._stageEventId = 0;

        this._hotZone = new St.Widget({reactive: true, track_hover: true});
        this._hotZone.connect('notify::hover', () => this._updateReveal());

        this.actor = new St.BoxLayout({
            style_class: 'notchline-pill',
            reactive: true,
            track_hover: true,
            clip_to_allocation: true,
        });
        this.actor.connect('notify::hover', () => this._updateReveal());

        this._content = new St.BoxLayout({
            style_class: 'notchline-content',
            x_expand: true,
            opacity: 0,
        });
        this._icon = new St.Icon({
            style_class: 'notchline-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const text = new St.BoxLayout({
            style_class: 'notchline-text',
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._title = new St.Label({style_class: 'notchline-title'});
        this._body = new St.Label({style_class: 'notchline-body'});
        this._setFullText(false);

        text.add_child(this._title);
        text.add_child(this._body);
        this._content.add_child(this._icon);
        this._content.add_child(text);
        this.actor.add_child(this._content);

        this.actor.connect('button-press-event', (_actor, event) => this._onPress(event));
        this.actor.connect('motion-event', (_actor, event) => this._onMotion(event));
        this.actor.connect('button-release-event', () => this._onRelease());

        // Added first so the notch stays above it
        Main.layoutManager.addTopChrome(this._hotZone, {trackFullscreen: true});
        Main.layoutManager.addTopChrome(this.actor);
        Main.layoutManager.connectObject('monitors-changed', () => this._apply(false), this);
        this._apply(false);
    }

    // True while the user is looking at or touching the notch
    get held() {
        return this.actor.hover || this.open || !!this._drag;
    }

    setConfig(config) {
        this._config = config;
        if (!config.pill.reveal_on_hover) {
            this._clearRevealTimeout();
            this._revealed = false;
        }
        this._apply(false);
    }

    setContent({title, body, gicon}) {
        this._title.text = title ?? '';
        this._body.text = body ?? '';
        this._body.visible = !!body;
        this._icon.gicon = gicon ?? new Gio.ThemedIcon({name: 'dialog-information-symbolic'});
    }

    expand() {
        this.expanded = true;
        this._apply(true);
    }

    collapse(onDone) {
        this.expanded = false;
        this._collapsing = true;
        this._apply(true, () => {
            this._collapsing = false;
            onDone?.();
            // Apply a state change that happened mid-collapse
            if (this._mode() !== this._shownMode)
                this._apply(true);
        });
    }

    _mode() {
        if (this.open)
            return 'full';
        if (this.expanded)
            return 'expanded';
        return this._idleShown() ? 'idle' : 'hidden';
    }

    _idleShown() {
        const p = this._config.pill;
        return p.reveal_on_hover ? this._revealed : p.idle_visible;
    }

    _updateReveal() {
        this._clearRevealTimeout();
        if (!this._config.pill.reveal_on_hover)
            return;

        if (this._hotZone.hover || this.actor.hover) {
            this._setRevealed(true);
            return;
        }
        this._revealTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REVEAL_HIDE_DELAY_MS, () => {
            this._revealTimeoutId = 0;
            this._setRevealed(false);
            return GLib.SOURCE_REMOVE;
        });
    }

    _setRevealed(revealed) {
        if (this._revealed === revealed)
            return;
        this._revealed = revealed;
        // A running collapse picks this up when done
        if (!this._collapsing && this._mode() !== this._shownMode)
            this._apply(true);
    }

    _clearRevealTimeout() {
        if (this._revealTimeoutId) {
            GLib.source_remove(this._revealTimeoutId);
            this._revealTimeoutId = 0;
        }
    }

    _setOpen(open) {
        this.open = open;
        if (open && !this._stageEventId) {
            this._stageEventId = global.stage.connect('captured-event',
                (_stage, event) => this._onStageEvent(event));
        } else if (!open && this._stageEventId) {
            global.stage.disconnect(this._stageEventId);
            this._stageEventId = 0;
        }
        this._apply(true);
    }

    _onStageEvent(event) {
        const type = event.type();
        if (type !== Clutter.EventType.BUTTON_PRESS && type !== Clutter.EventType.TOUCH_BEGIN)
            return Clutter.EVENT_PROPAGATE;

        // Close the pulled-open notch on any press outside of it
        if (!this.actor.contains(global.stage.get_event_actor(event)))
            this._setOpen(false);
        return Clutter.EVENT_PROPAGATE;
    }

    _onPress(event) {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY || this._collapsing || this._drag)
            return Clutter.EVENT_PROPAGATE;

        const [, y] = event.get_coords();
        this._drag = {startY: y, fromOpen: this.open, active: false, progress: this.open ? 1 : 0};
        this._grab = global.stage.grab(this.actor);
        return Clutter.EVENT_STOP;
    }

    _onMotion(event) {
        const drag = this._drag;
        if (!drag)
            return Clutter.EVENT_PROPAGATE;

        const {scale_factor: scale} = St.ThemeContext.get_for_stage(global.stage);
        const [, y] = event.get_coords();
        const dy = y - drag.startY;

        if (!drag.active) {
            if (Math.abs(dy) < DRAG_THRESHOLD * scale)
                return Clutter.EVENT_STOP;

            drag.active = true;
            if (!drag.fromOpen)
                this._onPull();
            drag.closedHasContent = this.expanded;
            drag.closed = this._geometry(this.expanded ? 'expanded' : 'idle');
            drag.full = this._geometry('full');
            this.actor.remove_all_transitions();
            this._content.remove_all_transitions();
            this._content.opacity = drag.fromOpen || drag.closedHasContent ? 255 : 0;
        }

        const range = Math.max(drag.full.height - drag.closed.height, MIN_PULL_RANGE * scale);
        const t = Math.min(Math.max((drag.fromOpen ? 1 : 0) + dy / range, 0), 1);
        const lerp = (from, to) => Math.round(from + (to - from) * t);
        const width = lerp(drag.closed.width, drag.full.width);

        drag.progress = t;
        this.actor.set_position(drag.closed.x + Math.round((drag.closed.width - width) / 2), drag.closed.y);
        this.actor.set_size(width, lerp(drag.closed.height, drag.full.height));
        if (!drag.closedHasContent)
            this._content.opacity = lerp(0, 255);
        return Clutter.EVENT_STOP;
    }

    _onRelease() {
        const drag = this._drag;
        if (!drag)
            return Clutter.EVENT_PROPAGATE;

        this._drag = null;
        this._grab?.dismiss();
        this._grab = null;

        if (drag.active) {
            this._setOpen(drag.fromOpen
                ? drag.progress > PULL_CLOSE_THRESHOLD
                : drag.progress > PULL_OPEN_THRESHOLD);
        } else {
            if (this.open)
                this._setOpen(false);
            this._onClick();
        }
        this._updateReveal();
        return Clutter.EVENT_STOP;
    }

    _setFullText(full) {
        for (const label of [this._title, this._body]) {
            label.clutter_text.line_wrap = full;
            label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            label.clutter_text.ellipsize = full ? Pango.EllipsizeMode.NONE : Pango.EllipsizeMode.END;
        }
        if (full)
            this.actor.add_style_class_name('notchline-full');
        else
            this.actor.remove_style_class_name('notchline-full');
    }

    _placeHotZone() {
        const {x, width} = this._geometry('idle');
        const {scale_factor: scale} = St.ThemeContext.get_for_stage(global.stage);
        this._hotZone.set_position(x, Main.layoutManager.primaryMonitor.y);
        this._hotZone.set_size(width, HOT_ZONE_HEIGHT * scale);
        this._hotZone.reactive = this._config.pill.reveal_on_hover;
    }

    _geometry(mode) {
        const monitor = Main.layoutManager.primaryMonitor;
        const {scale_factor: scale} = St.ThemeContext.get_for_stage(global.stage);
        const p = this._config.pill;
        let width, height;
        if (mode === 'full') {
            // Grow to fit the wrapped text, never smaller than a banner
            width = p.expanded_width * scale;
            this._setFullText(true);
            const [, natural] = this.actor.get_preferred_height(width);
            height = Math.max(p.expanded_height * scale,
                Math.min(natural, monitor.height * FULL_MAX_HEIGHT));
        } else {
            width = (mode === 'expanded' ? p.expanded_width : p.idle_width) * scale;
            height = (mode === 'expanded' ? p.expanded_height : p.idle_height) * scale;
        }
        return {
            x: monitor.x + Math.round((monitor.width - width) / 2),
            y: monitor.y + p.top_offset * scale,
            width,
            height,
        };
    }

    _apply(animate, onComplete) {
        if (!Main.layoutManager.primaryMonitor)
            return;

        const mode = this._mode();
        this._shownMode = mode;
        // The drag owns the geometry; the release settles it
        if (this._drag?.active) {
            onComplete?.();
            return;
        }

        const p = this._config.pill;
        const {scale_factor: scale} = St.ThemeContext.get_for_stage(global.stage);
        const showContent = mode === 'expanded' || mode === 'full';
        const geometry = this._geometry(mode === 'hidden' ? 'idle' : mode);
        if (mode !== 'full')
            this._setFullText(false);
        // CSS lengths are scaled by St, so the radius stays in logical pixels
        this.actor.style = `background-color: ${hexToRgba(p.background, p.opacity)}; ` +
            `border-radius: ${Math.min(p.radius, geometry.height / scale / 2)}px;`;
        this._placeHotZone();

        if (!animate) {
            this.actor.remove_all_transitions();
            this._content.remove_all_transitions();
            this.actor.set_position(geometry.x, geometry.y);
            this.actor.set_size(geometry.width, geometry.height);
            this.actor.opacity = 255;
            this.actor.visible = mode !== 'hidden';
            this._content.opacity = showContent ? 255 : 0;
            onComplete?.();
            return;
        }

        const fadeContent = opacity => this._content.ease({
            opacity,
            duration: CONTENT_FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        if (!showContent)
            fadeContent(0);
        const done = () => {
            if (showContent)
                fadeContent(255);
            onComplete?.();
        };

        if (mode === 'hidden') {
            if (this.actor.visible)
                this._retract(done);
            else
                done();
        } else if (!this.actor.visible) {
            this._drip(geometry, done);
        } else {
            this.actor.ease({
                ...geometry,
                opacity: 255,
                duration: p.animation_ms,
                mode: geometry.height > this.actor.height
                    ? Clutter.AnimationMode.EASE_OUT_BACK
                    : Clutter.AnimationMode.EASE_IN_OUT_QUAD,
                onComplete: done,
            });
        }
    }

    // Appear like a drop: stretch down from the top edge, then spread out
    _drip(target, onComplete) {
        const {animation_ms: duration} = this._config.pill;
        const drop = Math.min(target.width, target.height);

        this.actor.remove_all_transitions();
        this.actor.set_position(target.x + Math.round((target.width - drop) / 2), target.y);
        this.actor.set_size(drop, 0);
        this.actor.opacity = 255;
        this.actor.show();
        this.actor.ease({
            height: target.height,
            duration: duration / 2,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => this.actor.ease({
                x: target.x,
                width: target.width,
                duration,
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
                onComplete,
            }),
        });
    }

    // The drop in reverse: pull in to a drop, then retract up into the edge
    _retract(onComplete) {
        const {animation_ms: duration} = this._config.pill;
        const {x, width, height} = this.actor;
        const drop = Math.min(width, height);

        this.actor.ease({
            x: x + Math.round((width - drop) / 2),
            width: drop,
            duration: duration / 2,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => this.actor.ease({
                height: 0,
                duration: duration / 2,
                mode: Clutter.AnimationMode.EASE_IN_QUAD,
                onComplete: () => {
                    this.actor.hide();
                    onComplete?.();
                },
            }),
        });
    }

    destroy() {
        this._clearRevealTimeout();
        this._grab?.dismiss();
        this._grab = null;
        if (this._stageEventId)
            global.stage.disconnect(this._stageEventId);
        Main.layoutManager.disconnectObject(this);
        Main.layoutManager.removeChrome(this.actor);
        Main.layoutManager.removeChrome(this._hotZone);
        this.actor.destroy();
        this._hotZone.destroy();
    }
}

export default class NotchlineExtension extends Extension {
    enable() {
        this._config = mergeConfig(null);
        this._queue = [];
        this._current = null;
        this._collapsing = false;
        this._timeoutId = 0;

        this._lastContent = null;

        this._pill = new Pill(this._config, {
            onClick: () => this._onPillClicked(),
            onPull: () => this._onPull(),
        });

        this._injections = new InjectionManager();
        const ext = this;
        this._injections.overrideMethod(MessageTray.MessageTray.prototype, '_showNotification',
            original => function () {
                const {hide_gnome_banners: hide, capture_system: capture} = ext._config.behavior;
                if (!hide || !capture) {
                    original.call(this);
                    return;
                }
                // Drop GNOME's banner queue; the notch shows these instead
                this._notificationQueue = [];
                this.emit('queue-changed');
            });

        Main.messageTray.connectObject('source-added', (_tray, source) => this._watchSource(source), this);
        Main.messageTray.getSources().forEach(source => this._watchSource(source));

        this._cancellable = new Gio.Cancellable();
        this._proxy = new NotchlineProxy(Gio.DBus.session, BUS_NAME, OBJECT_PATH,
            (proxy, error) => this._onProxyReady(proxy, error), this._cancellable);
    }

    disable() {
        this._cancellable.cancel();
        this._cancellable = null;
        if (this._proxy) {
            this._proxySignalIds?.forEach(id => this._proxy.disconnectSignal(id));
            this._proxy.disconnectObject(this);
        }
        this._proxy = null;
        this._proxySignalIds = null;

        Main.messageTray.disconnectObject(this);
        Main.messageTray.getSources().forEach(source => source.disconnectObject(this));

        this._injections.clear();
        this._injections = null;

        this._clearTimeout();
        [this._current, ...this._queue].forEach(item => item && this._release(item));
        this._current = null;
        this._queue = null;

        this._pill.destroy();
        this._pill = null;
    }

    _onProxyReady(proxy, error) {
        if (error) {
            if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.warn(`Notchline: daemon proxy failed: ${error.message}`);
            return;
        }

        this._proxySignalIds = [
            proxy.connectSignal('ShowRequested', (_p, _sender, [id, title, body, icon, timeoutMs]) => {
                this._enqueue({
                    id,
                    title,
                    body,
                    gicon: icon ? new Gio.ThemedIcon({name: icon}) : null,
                    timeout: timeoutMs,
                });
            }),
            proxy.connectSignal('DismissRequested', (_p, _sender, [id]) => {
                this._removeItem(item => item.id === id);
            }),
        ];
        proxy.connectObject('g-properties-changed', () => this._applyConfig(proxy.Config), this);
        this._applyConfig(proxy.Config);
    }

    _applyConfig(json) {
        if (!json)
            return;
        this._config = mergeConfig(json);
        this._pill.setConfig(this._config);
    }

    _watchSource(source) {
        source.connectObject('notification-request-banner',
            (_source, notification) => this._onRequestBanner(notification), this);
    }

    _shouldCapture(notification) {
        if (!this._config.behavior.capture_system || notification.acknowledged)
            return false;

        // Same filters GNOME applies before showing a banner
        const critical = notification.urgency === MessageTray.Urgency.CRITICAL;
        if (notification.urgency === MessageTray.Urgency.LOW)
            return false;
        if (!notification.source.policy.showBanners && !critical)
            return false;
        if (Main.layoutManager.primaryMonitor?.inFullscreen && !critical && !notification.forFeedback)
            return false;
        return true;
    }

    _onRequestBanner(notification) {
        if (!this._shouldCapture(notification))
            return;

        if (this._current?.notification === notification) {
            // Updated while shown: refresh text and extend the display time
            notification.acknowledged = true;
            this._lastContent = this._contentFor(this._current);
            this._pill.setContent(this._lastContent);
            this._scheduleHide(this._current.timeout);
            return;
        }
        if (this._queue.some(item => item.notification === notification))
            return;

        const item = {notification, timeout: this._config.behavior.timeout_ms};
        item.destroyId = notification.connect('destroy', () => this._removeItem(i => i === item));
        this._enqueue(item);
    }

    _contentFor(item) {
        const {notification} = item;
        if (!notification)
            return item;

        let body = notification.body ?? '';
        if (notification.useBodyMarkup)
            body = body.replace(/<[^>]*>/g, '');
        return {
            title: notification.title || notification.source?.title || '',
            body: body.replace(/\s+/g, ' ').trim(),
            gicon: notification.gicon ?? notification.source?.icon ?? null,
        };
    }

    _enqueue(item) {
        this._queue.push(item);
        if (!this._current)
            this._showNext();
    }

    _showNext() {
        const item = this._queue.shift();
        if (!item)
            return;

        this._current = item;
        if (item.notification)
            item.notification.acknowledged = true;
        this._lastContent = this._contentFor(item);
        this._pill.setContent(this._lastContent);
        this._pill.expand();
        this._scheduleHide(item.timeout);
    }

    _scheduleHide(ms) {
        this._clearTimeout();
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            if (this._pill.held) {
                this._scheduleHide(HOVER_RECHECK_MS);
                return GLib.SOURCE_REMOVE;
            }
            this._timeoutId = 0;
            this._finishCurrent();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearTimeout() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }

    _finishCurrent() {
        const item = this._current;
        if (!item || this._collapsing)
            return;

        this._clearTimeout();
        this._collapsing = true;
        this._pill.collapse(() => {
            this._collapsing = false;
            this._release(item);
            this._current = null;
            this._showNext();
        });
    }

    _removeItem(match) {
        if (this._current && match(this._current)) {
            this._finishCurrent();
            return;
        }
        this._queue = this._queue.filter(item => {
            if (!match(item))
                return true;
            this._release(item);
            return false;
        });
    }

    _release(item) {
        if (item.destroyId) {
            item.notification.disconnect(item.destroyId);
            item.destroyId = 0;
        }
    }

    _onPull() {
        // Pulling the idle notch shows the last notification again
        if (!this._current)
            this._pill.setContent(this._lastContent ?? {title: 'No notifications', body: ''});
    }

    _onPillClicked() {
        const item = this._current;
        if (!item || this._collapsing)
            return;

        // activate() destroys non-resident notifications, which also finishes them here
        item.notification?.activate();
        this._finishCurrent();
    }
}
