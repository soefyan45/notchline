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
    constructor(config, onClick) {
        this._config = config;
        this.expanded = false;

        this.actor = new St.BoxLayout({
            style_class: 'notchline-pill',
            reactive: true,
            track_hover: true,
        });

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
        for (const label of [this._title, this._body])
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        text.add_child(this._title);
        text.add_child(this._body);
        this._content.add_child(this._icon);
        this._content.add_child(text);
        this.actor.add_child(this._content);

        this.actor.connect('button-release-event', () => {
            onClick();
            return Clutter.EVENT_STOP;
        });

        Main.layoutManager.addTopChrome(this.actor);
        Main.layoutManager.connectObject('monitors-changed', () => this._move(this.expanded, false), this);
        this._move(false, false);
    }

    get hovered() {
        return this.actor.hover;
    }

    setConfig(config) {
        this._config = config;
        this._move(this.expanded, false);
    }

    setContent({title, body, gicon}) {
        this._title.text = title ?? '';
        this._body.text = body ?? '';
        this._body.visible = !!body;
        this._icon.gicon = gicon ?? new Gio.ThemedIcon({name: 'dialog-information-symbolic'});
    }

    expand() {
        this.expanded = true;
        this._move(true, true, () => {
            this._content.ease({
                opacity: 255,
                duration: CONTENT_FADE_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        });
    }

    collapse(onDone) {
        this._content.ease({
            opacity: 0,
            duration: CONTENT_FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this.expanded = false;
                this._move(false, true, onDone);
            },
        });
    }

    _geometry(expanded) {
        const monitor = Main.layoutManager.primaryMonitor;
        const {scale_factor: scale} = St.ThemeContext.get_for_stage(global.stage);
        const p = this._config.pill;
        const width = (expanded ? p.expanded_width : p.idle_width) * scale;
        const height = (expanded ? p.expanded_height : p.idle_height) * scale;
        return {
            x: monitor.x + Math.round((monitor.width - width) / 2),
            y: monitor.y + p.top_offset * scale,
            width,
            height,
        };
    }

    _move(expanded, animate, onComplete) {
        if (!Main.layoutManager.primaryMonitor)
            return;

        const p = this._config.pill;
        const height = expanded ? p.expanded_height : p.idle_height;
        // CSS lengths are scaled by St, so the radius stays in logical pixels
        this.actor.style = `background-color: ${hexToRgba(p.background, p.opacity)}; ` +
            `border-radius: ${Math.min(p.radius, height / 2)}px;`;

        const visible = expanded || p.idle_visible;
        const geometry = this._geometry(expanded);

        if (!animate) {
            this.actor.remove_all_transitions();
            this.actor.set_position(geometry.x, geometry.y);
            this.actor.set_size(geometry.width, geometry.height);
            this.actor.opacity = 255;
            this.actor.visible = visible;
            this._content.opacity = expanded ? 255 : 0;
            onComplete?.();
            return;
        }

        if (expanded && !this.actor.visible) {
            this.actor.opacity = 0;
            this.actor.show();
        }

        this.actor.ease({
            ...geometry,
            opacity: visible ? 255 : 0,
            duration: p.animation_ms,
            mode: expanded
                ? Clutter.AnimationMode.EASE_OUT_BACK
                : Clutter.AnimationMode.EASE_IN_OUT_QUAD,
            onComplete: () => {
                if (!visible) {
                    this.actor.hide();
                    this.actor.opacity = 255;
                }
                onComplete?.();
            },
        });
    }

    destroy() {
        Main.layoutManager.disconnectObject(this);
        Main.layoutManager.removeChrome(this.actor);
        this.actor.destroy();
    }
}

export default class NotchlineExtension extends Extension {
    enable() {
        this._config = mergeConfig(null);
        this._queue = [];
        this._current = null;
        this._collapsing = false;
        this._timeoutId = 0;

        this._pill = new Pill(this._config, () => this._onPillClicked());

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
            this._pill.setContent(this._contentFor(this._current));
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
        this._pill.setContent(this._contentFor(item));
        this._pill.expand();
        this._scheduleHide(item.timeout);
    }

    _scheduleHide(ms) {
        this._clearTimeout();
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            if (this._pill.hovered) {
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

    _onPillClicked() {
        const item = this._current;
        if (!item || this._collapsing)
            return;

        // activate() destroys non-resident notifications, which also finishes them here
        item.notification?.activate();
        this._finishCurrent();
    }
}
