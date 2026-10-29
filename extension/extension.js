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
    <method name="ShowStatus">
      <arg type="s" name="icon" direction="in"/>
      <arg type="s" name="text" direction="in"/>
      <arg type="s" name="trail" direction="in"/>
      <arg type="s" name="color" direction="in"/>
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
    <signal name="StatusRequested">
      <arg type="u" name="id"/>
      <arg type="s" name="icon"/>
      <arg type="s" name="text"/>
      <arg type="s" name="trail"/>
      <arg type="s" name="color"/>
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
        style: 'menyatu',
        idle_width: 200,
        idle_height: 32,
        expanded_width: 420,
        expanded_height: 72,
        top_offset: 4,
        radius: 20,
        background: '#000000',
        opacity: 0.95,
        animation_ms: 280,
    },
    behavior: {
        timeout_ms: 4000,
        hide_gnome_banners: true,
        capture_system: true,
    },
    drop: {
        enabled: true,
        pull_range: 80,
        max_depth: 22,
        min_width: 5,
        max_width: 11,
        blend: 6,
    },
    // [stiffness, damping] pairs, underdamped so the shape wobbles like a liquid. Height
    // forms before width, so the notch drips first and then spreads.
    spring: {
        width_stiffness: 170,
        width_damping: 15,
        height_stiffness: 320,
        height_damping: 22,
        drop_stiffness: 520,
        drop_damping: 20,
        drop_x_stiffness: 600,
        drop_x_damping: 45,
    },
};

const HOVER_RECHECK_MS = 500;
const CONTENT_FADE_MS = 120;
// Height of the top edge strip that reveals the idle notch
const HOT_ZONE_HEIGHT = 2;
// Grace period before hiding, so moving from the edge onto the notch doesn't flicker
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
// Hover time on a compact notification before it opens in full
const HOVER_OPEN_DELAY_MS = 300;
// Size of the concave corners joining the merged notch to the top edge
const EAR_SIZE = 10;
// How often the pointer is checked while it is far from the notch
const POINTER_POLL_MS = 60;
// animation_ms the spring settings are tuned for
const SPRING_BASE_MS = 280;
// Distance (px) at which a moving shape counts as arrived, for content and callbacks
const NEAR_PX = 2;
// Body padding (logical px): side padding of the compact line, [vertical, side] of the detail
const COMPACT_PADDING = 14;
const DETAIL_PADDING = [14, 18];
const COMPACT_MAX_WIDTH = 480;
// Design token names a status may use; each maps to a notchline-<name> CSS class
const COLORS = ['accent', 'success', 'warn', 'danger', 'muted'];

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
        drop: {...DEFAULT_CONFIG.drop, ...parsed.drop},
        spring: {...DEFAULT_CONFIG.spring, ...parsed.spring},
    };
}

function parseHex(hex) {
    const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? '');
    return match ? match.slice(1).map(v => parseInt(v, 16)) : [0, 0, 0];
}

function scaleFactor() {
    return St.ThemeContext.get_for_stage(global.stage).scale_factor;
}

const easeOutQuad = t => t * (2 - t);

// Polynomial smooth maximum: like max(), but blends the two within k of each other.
// k shrinks to nothing where either side is flat, so empty areas stay empty.
function smoothMax(a, b, k) {
    k = Math.min(k, 2 * Math.min(a, b));
    if (k <= 0)
        return Math.max(a, b);
    const h = Math.max(k - Math.abs(a - b), 0) / k;
    return Math.max(a, b) + h * h * k / 4;
}

class Spring {
    constructor() {
        this.stiffness = 0;
        this.damping = 0;
        this.value = 0;
        this.target = 0;
        this.velocity = 0;
    }

    // speed > 1 makes the spring faster without changing how bouncy it is
    step(dt, speed) {
        const force = -this.stiffness * speed * speed * (this.value - this.target) -
            this.damping * speed * this.velocity;
        this.velocity += force * dt;
        this.value += this.velocity * dt;
    }

    near(px) {
        return Math.abs(this.value - this.target) < px;
    }

    get settled() {
        return Math.abs(this.value - this.target) < 0.25 && Math.abs(this.velocity) < 1;
    }

    snap(value = this.target) {
        this.value = this.target = value;
        this.velocity = 0;
    }
}

function setColorClass(actor, color) {
    for (const name of COLORS)
        actor.remove_style_class_name(`notchline-${name}`);
    if (COLORS.includes(color))
        actor.add_style_class_name(`notchline-${color}`);
}

class Pill {
    constructor(config, {onClick, onPull}) {
        this._config = config;
        this._onClick = onClick;
        this._onPull = onPull;
        this.expanded = false;
        this.open = false;
        this._collapsing = false;
        this._hovered = false;
        this._hoverOpen = false;
        // Set when the user closed the notch while over it, until the pointer leaves
        this._hoverOpenBlocked = false;
        this._hoverTimeoutId = 0;
        this._overBody = false;
        this._atEdge = false;
        this._pointerActive = false;
        this._shownMode = null;
        this._layer = null;
        this._contentPending = false;
        this._settleCallbacks = [];
        this._drag = null;
        this._grab = null;
        this._stageEventId = 0;
        this._left = 0;
        this._still = true;

        // Body size, and the drop that reaches for the pointer, all moved by springs
        this._width = new Spring();
        this._height = new Spring();
        this._drop = new Spring();
        this._dropX = new Spring();
        this._tuneSprings();

        // The silhouette is drawn rather than styled so it can flow like a liquid
        this.actor = new St.Widget({reactive: true, clip_to_allocation: true, visible: false});
        this._shape = new St.DrawingArea();
        this._shape.connect('repaint', area => this._paintShape(area));
        this._body = new St.BoxLayout({
            style_class: 'notchline-body',
            vertical: true,
            clip_to_allocation: true,
        });
        this.actor.add_child(this._shape);
        this.actor.add_child(this._body);

        this._content = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
            opacity: 0,
        });
        this._body.add_child(this._content);

        // Compact layer: one line, leading icon and text, trailing value
        this._compactRow = new St.BoxLayout({
            style_class: 'notchline-compact',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const lead = new St.BoxLayout({style_class: 'notchline-lead'});
        this._leadIcon = new St.Icon({
            style_class: 'notchline-lead-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._leadText = new St.Label({
            style_class: 'notchline-lead-text',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._trailText = new St.Label({
            style_class: 'notchline-trail-text',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        for (const label of [this._leadText, this._trailText])
            label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        lead.add_child(this._leadIcon);
        lead.add_child(this._leadText);
        this._compactRow.add_child(lead);
        this._compactRow.add_child(this._trailText);

        // Detail layer: the full notification, wrapped
        this._detail = new St.BoxLayout({
            style_class: 'notchline-detail',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._icon = new St.Icon({
            style_class: 'notchline-icon',
            y_align: Clutter.ActorAlign.START,
        });
        const text = new St.BoxLayout({
            style_class: 'notchline-text',
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._title = new St.Label({style_class: 'notchline-title'});
        this._bodyText = new St.Label({style_class: 'notchline-body-text'});
        for (const label of [this._title, this._bodyText]) {
            label.clutter_text.line_wrap = true;
            label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        }
        text.add_child(this._title);
        text.add_child(this._bodyText);
        this._detail.add_child(this._icon);
        this._detail.add_child(text);

        this._content.add_child(this._compactRow);
        this._content.add_child(this._detail);
        this._showLayer('compact');

        this.actor.connect('button-press-event', (_actor, event) => this._onPress(event));
        this.actor.connect('motion-event', (_actor, event) => this._onMotion(event));
        this.actor.connect('button-release-event', () => this._onRelease());

        Main.layoutManager.addTopChrome(this.actor);
        Main.layoutManager.connectObject('monitors-changed', () => this._apply(false), this);

        // Runs every frame while something moves or the pointer is close; otherwise a
        // slow poll waits for the pointer to come near
        this._ticker = new Clutter.Timeline({
            actor: Main.layoutManager.uiGroup,
            duration: 1000,
            repeat_count: -1,
        });
        this._ticker.connect('new-frame', () => this._tick(Math.min(this._ticker.get_delta(), 50) / 1000));
        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POINTER_POLL_MS, () => {
            if (!this._ticker.is_playing() && this._readPointer())
                this._wake();
            return GLib.SOURCE_CONTINUE;
        });

        this._apply(false);
    }

    // True while the user is looking at or touching the notch
    get held() {
        return this._overBody || this.open || !!this._drag;
    }

    setConfig(config) {
        this._config = config;
        this._tuneSprings();
        this._apply(false);
    }

    _tuneSprings() {
        const s = this._config.spring;
        for (const [spring, name] of [[this._width, 'width'], [this._height, 'height'],
            [this._drop, 'drop'], [this._dropX, 'drop_x']]) {
            spring.stiffness = s[`${name}_stiffness`];
            spring.damping = s[`${name}_damping`];
        }
    }

    // spec: {icon, iconColor, text, trail, trailColor, trailMono, title, body}
    setItem(spec) {
        this._spec = spec;
        const icon = spec.icon ?? new Gio.ThemedIcon({name: 'dialog-information-symbolic'});

        this._leadIcon.gicon = icon;
        setColorClass(this._leadIcon, spec.iconColor);
        this._leadText.text = spec.text ?? '';
        this._leadText.visible = !!spec.text;
        this._trailText.text = spec.trail ?? '';
        this._trailText.visible = !!spec.trail;
        setColorClass(this._trailText, spec.trailColor);
        if (spec.trailMono)
            this._trailText.add_style_class_name('notchline-mono');
        else
            this._trailText.remove_style_class_name('notchline-mono');

        this._icon.gicon = icon;
        setColorClass(this._icon, spec.iconColor);
        this._title.text = spec.title ?? spec.text ?? '';
        this._bodyText.text = spec.body ?? '';
        this._bodyText.visible = !!spec.body;
    }

    expand() {
        this.expanded = true;
        this._apply(true);
    }

    // Re-fit the notch after the shown item changed
    refresh() {
        if (!this._collapsing)
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
        if (this.open || (this._hoverOpen && this.expanded && this._spec?.body))
            return 'full';
        if (this.expanded)
            return 'compact';
        return this._idleShown() ? 'idle' : 'hidden';
    }

    _idleShown() {
        const p = this._config.pill;
        return p.reveal_on_hover ? this._hovered : p.idle_visible;
    }

    _merged() {
        return this._config.pill.style !== 'pulau';
    }

    _wake() {
        if (!this._ticker.is_playing())
            this._ticker.start();
    }

    _tick(dt) {
        if (!Main.layoutManager.primaryMonitor)
            return;

        this._readPointer();
        const springs = [this._width, this._height, this._drop, this._dropX];
        if (springs.every(spring => spring.settled)) {
            // Lay out once more at rest, then leave the shape alone
            if (!this._still) {
                this._still = true;
                springs.forEach(spring => spring.snap());
                this._layout();
            }
        } else {
            this._still = false;
            const speed = SPRING_BASE_MS / Math.max(this._config.pill.animation_ms, 1);
            // Small steps keep the stiff springs stable on slow frames
            const steps = Math.ceil(dt / (1 / 240));
            for (let i = 0; i < steps; i++)
                springs.forEach(spring => spring.step(dt / steps, speed));
            if (!this._drag?.active)
                this._layout();
        }

        const near = NEAR_PX * scaleFactor();
        if (this._width.near(near) && this._height.near(near)) {
            if (this._contentPending) {
                this._contentPending = false;
                this._content.ease({
                    opacity: 255,
                    duration: CONTENT_FADE_MS,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            }
            this._flushCallbacks();
        }

        if (this._still && !this._pointerActive && !this._drag)
            this._ticker.stop();
    }

    _flushCallbacks() {
        const callbacks = this._settleCallbacks;
        this._settleCallbacks = [];
        callbacks.forEach(callback => callback());
    }

    // Track the pointer: hover over the notch or the top edge, and the drop's pull.
    // Returns whether the pointer is close enough to keep the per-frame updates running.
    _readPointer() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return false;

        const scale = scaleFactor();
        const p = this._config.pill;
        const [px, py] = global.get_pointer();
        const cx = monitor.x + monitor.width / 2;
        const top = this._top();
        const width = Math.max(this._width.value, 0);
        const height = Math.max(this._height.value, 0);
        const half = Math.max(width / 2, p.idle_width * scale / 2);
        const dx = px - cx;
        const usable = !monitor.inFullscreen;

        const atEdge = usable && p.reveal_on_hover && Math.abs(dx) <= half &&
            py >= monitor.y && py <= monitor.y + HOT_ZONE_HEIGHT * scale;
        const overBody = usable && width > 1 && height > 1 &&
            Math.abs(dx) <= width / 2 && py >= top && py <= top + height;

        // The drop reaches for a pointer just below the notch (or the empty top edge)
        let depth = 0;
        const d = this._config.drop;
        const canPull = d.enabled && usable && this._merged() && !overBody && !this.open && !this._drag &&
            (p.reveal_on_hover || width > 1);
        if (canPull) {
            const range = d.pull_range * scale;
            const dist = py - (top + this._bodyAt(dx, width, height));
            if (Math.abs(dx) <= half + range / 4 && dist >= 0 && dist <= range) {
                depth = Math.min(dist, d.max_depth * scale) * easeOutQuad(1 - dist / range);
                const reach = Math.max(half - d.min_width * scale, 0);
                const x = cx + Math.min(Math.max(dx, -reach), reach);
                // A new drop starts right under the pointer instead of sliding over
                if (this._drop.value < 0.5)
                    this._dropX.snap(x);
                else
                    this._dropX.target = x;
            }
        }
        this._drop.target = depth;

        this._pointerActive = depth > 0 || overBody || atEdge;
        if (overBody !== this._overBody || atEdge !== this._atEdge) {
            this._overBody = overBody;
            this._atEdge = atEdge;
            this._updateHover();
        }
        return this._pointerActive;
    }

    _updateHover() {
        this._clearHoverTimeout();
        if (this._atEdge || this._overBody) {
            this._setHover(true, this._hoverOpen);
            // Open the full notification after the pointer rests on the notch
            if (this._overBody && !this._hoverOpen && !this._hoverOpenBlocked) {
                this._hoverTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOVER_OPEN_DELAY_MS, () => {
                    this._hoverTimeoutId = 0;
                    this._setHover(true, true);
                    return GLib.SOURCE_REMOVE;
                });
            }
            return;
        }
        // Grace period so moving from the edge onto the notch doesn't flicker
        this._hoverOpenBlocked = false;
        this._hoverTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REVEAL_HIDE_DELAY_MS, () => {
            this._hoverTimeoutId = 0;
            this._setHover(false, false);
            return GLib.SOURCE_REMOVE;
        });
    }

    _setHover(hovered, hoverOpen) {
        this._hovered = hovered;
        this._hoverOpen = hoverOpen;
        // A running collapse picks this up when done
        if (!this._collapsing && this._mode() !== this._shownMode)
            this._apply(true);
    }

    _clearHoverTimeout() {
        if (this._hoverTimeoutId) {
            GLib.source_remove(this._hoverTimeoutId);
            this._hoverTimeoutId = 0;
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
        this._drag = {startY: y, fromOpen: this._mode() === 'full', active: false};
        this._drag.progress = this._drag.fromOpen ? 1 : 0;
        this._grab = global.stage.grab(this.actor);
        return Clutter.EVENT_STOP;
    }

    _onMotion(event) {
        const drag = this._drag;
        if (!drag)
            return Clutter.EVENT_PROPAGATE;

        const scale = scaleFactor();
        const [, y] = event.get_coords();
        const dy = y - drag.startY;

        if (!drag.active) {
            if (Math.abs(dy) < DRAG_THRESHOLD * scale)
                return Clutter.EVENT_STOP;

            drag.active = true;
            this._clearHoverTimeout();
            if (!this.expanded)
                this._onPull();
            drag.closed = this._bodySize(this.expanded ? 'compact' : 'idle');
            drag.full = this._bodySize('full');
            this._drop.target = 0;
            this._content.remove_all_transitions();
            this._contentPending = false;
            this._showLayer('detail');
            this._styleBody();
            this._content.opacity = drag.fromOpen ? 255 : 0;
            this._wake();
        }

        const range = Math.max(drag.full.height - drag.closed.height, MIN_PULL_RANGE * scale);
        const t = Math.min(Math.max((drag.fromOpen ? 1 : 0) + dy / range, 0), 1);
        const lerp = (from, to) => Math.round(from + (to - from) * t);

        drag.progress = t;
        this._width.snap(lerp(drag.closed.width, drag.full.width));
        this._height.snap(lerp(drag.closed.height, drag.full.height));
        this._layout();
        if (!drag.fromOpen)
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
            // The pull decides; hovering must not reopen what was pushed closed
            const open = drag.fromOpen
                ? drag.progress > PULL_CLOSE_THRESHOLD
                : drag.progress > PULL_OPEN_THRESHOLD;
            this._hoverOpen = false;
            this._hoverOpenBlocked = !open;
            this._setOpen(open);
        } else {
            this._hoverOpen = false;
            this._hoverOpenBlocked = true;
            if (this.open)
                this._setOpen(false);
            this._onClick();
        }
        this._updateHover();
        return Clutter.EVENT_STOP;
    }

    _showLayer(layer) {
        this._layer = layer;
        this._compactRow.visible = layer === 'compact';
        this._detail.visible = layer === 'detail';
    }

    _top() {
        const monitor = Main.layoutManager.primaryMonitor;
        return monitor.y + (this._merged() ? 0 : this._config.pill.top_offset * scaleFactor());
    }

    // Body size (without the ears) for a mode, in stage pixels
    _bodySize(mode) {
        const monitor = Main.layoutManager.primaryMonitor;
        const scale = scaleFactor();
        const p = this._config.pill;
        if (mode === 'hidden')
            return {width: 0, height: 0};
        if (mode === 'full') {
            // Grow to fit the wrapped text, never smaller than a banner
            const width = p.expanded_width * scale;
            const inner = width - 2 * DETAIL_PADDING[1] * scale;
            const [, natural] = this._detail.get_preferred_height(inner);
            return {
                width,
                height: Math.max(p.expanded_height * scale,
                    Math.min(natural + 2 * DETAIL_PADDING[0] * scale, monitor.height * FULL_MAX_HEIGHT)),
            };
        }
        if (mode === 'compact') {
            // Fit the line, between the idle notch and a banner
            const [, natural] = this._compactRow.get_preferred_width(-1);
            return {
                width: Math.min(Math.max(natural + 2 * COMPACT_PADDING * scale, p.idle_width * scale),
                    COMPACT_MAX_WIDTH * scale),
                height: p.idle_height * scale,
            };
        }
        return {width: p.idle_width * scale, height: p.idle_height * scale};
    }

    // Depth of the merged notch's lower edge at dx from its center: flat bottom, rounded
    // corners, then concave ears back up to the top edge
    _bodyAt(dx, width, height) {
        const half = width / 2;
        if (half <= 0 || height <= 0)
            return 0;

        const t = Math.abs(dx);
        const radius = Math.min(this._config.pill.radius * scaleFactor(), height / 2, half);
        if (t <= half - radius)
            return height;
        if (t <= half)
            return height - radius + Math.sqrt(Math.max(radius ** 2 - (t - (half - radius)) ** 2, 0));
        const ear = Math.min(EAR_SIZE * scaleFactor(), height);
        if (t < half + ear)
            return ear - Math.sqrt(Math.max(ear ** 2 - (half + ear - t) ** 2, 0));
        return 0;
    }

    _dropWidth(depth) {
        const scale = scaleFactor();
        const {min_width: min, max_width: max} = this._config.drop;
        return Math.min(Math.max(depth * 0.55, min * scale), max * scale);
    }

    // Lower edge of the whole shape: the notch, with the drop blended in like a liquid
    _edgeAt(x, cx, width, height) {
        const body = this._bodyAt(x - cx, width, height);
        const depth = Math.max(this._drop.value, 0);
        if (depth < 0.25)
            return body;

        const dropX = this._dropX.value;
        const base = this._bodyAt(dropX - cx, width, height);
        const u = (x - dropX) / this._dropWidth(depth);
        const drop = (base + depth) * Math.exp(-u * u);
        return smoothMax(body, drop, this._config.drop.blend * scaleFactor());
    }

    _layout() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        const scale = scaleFactor();
        const width = Math.max(this._width.value, 0);
        const height = Math.max(this._height.value, 0);
        const depth = Math.max(this._drop.value, 0);
        const visible = (width > 0.5 && height > 0.5) || depth > 0.5;
        this.actor.visible = visible;
        if (!visible)
            return;

        // Bounding box of the notch, its ears and the drop
        const cx = monitor.x + monitor.width / 2;
        const ear = this._merged() ? EAR_SIZE * scale : 0;
        const dropReach = depth > 0.5 ? Math.abs(this._dropX.value - cx) + 3 * this._dropWidth(depth) : 0;
        const half = Math.ceil(Math.max(width / 2 + ear, dropReach, 1));
        const dropBottom = depth > 0.5 ? this._bodyAt(this._dropX.value - cx, width, height) + depth : 0;
        const boxHeight = Math.ceil(Math.max(height, dropBottom, 1)) + 1;

        this._left = Math.floor(cx - half);
        this.actor.set_position(this._left, this._top());
        this.actor.set_size(2 * half, boxHeight);
        this._shape.set_size(2 * half, boxHeight);
        this._body.set_position(Math.round(cx - width / 2) - this._left, 0);
        this._body.set_size(Math.round(width), Math.round(height));
        this._shape.queue_repaint();
    }

    _paintShape(area) {
        const cr = area.get_context();
        const [boxWidth] = area.get_surface_size();
        const p = this._config.pill;
        const [r, g, b] = parseHex(p.background);
        const monitor = Main.layoutManager.primaryMonitor;
        const width = Math.max(this._width.value, 0);
        const height = Math.max(this._height.value, 0);
        cr.setSourceRGBA(r / 255, g / 255, b / 255, p.opacity);

        if (monitor && this._merged()) {
            // Trace the lower edge pixel by pixel; the top edge is the screen edge
            const cx = monitor.x + monitor.width / 2 - this._left;
            cr.moveTo(0, 0);
            for (let x = 0; x <= boxWidth; x++)
                cr.lineTo(x, this._edgeAt(x, cx, width, height));
            cr.lineTo(boxWidth, 0);
            cr.closePath();
            cr.fill();
        } else if (width > 0 && height > 0) {
            const left = (boxWidth - width) / 2;
            const radius = Math.min(p.radius * scaleFactor(), height / 2, width / 2);
            cr.newSubPath();
            cr.arc(left + width - radius, radius, radius, -0.5 * Math.PI, 0);
            cr.arc(left + width - radius, height - radius, radius, 0, 0.5 * Math.PI);
            cr.arc(left + radius, height - radius, radius, 0.5 * Math.PI, Math.PI);
            cr.arc(left + radius, radius, radius, Math.PI, 1.5 * Math.PI);
            cr.closePath();
            cr.fill();
        }
        cr.$dispose();
    }

    _styleBody() {
        const [top, side] = this._layer === 'detail' ? DETAIL_PADDING : [0, COMPACT_PADDING];
        // CSS lengths are scaled by St, so this stays in logical pixels
        this._body.style = `padding: ${top}px ${side}px;`;
    }

    _apply(animate, onComplete) {
        if (!Main.layoutManager.primaryMonitor)
            return;

        const mode = this._mode();
        this._shownMode = mode;
        // The drag owns the shape; the release settles it
        if (this._drag?.active) {
            onComplete?.();
            return;
        }

        const layer = {full: 'detail', compact: 'compact'}[mode] ?? null;
        if (layer && layer !== this._layer) {
            // Swap layers while hidden, then fade the new one in once the shape arrives
            this._content.remove_all_transitions();
            this._content.opacity = 0;
            this._showLayer(layer);
        }
        this._styleBody();
        const size = this._bodySize(mode);
        this._width.target = size.width;
        this._height.target = size.height;

        if (!animate) {
            this._width.snap();
            this._height.snap();
            this._content.remove_all_transitions();
            this._content.opacity = layer ? 255 : 0;
            this._contentPending = false;
            this._layout();
            this._flushCallbacks();
            onComplete?.();
            return;
        }

        if (layer) {
            this._contentPending = this._content.opacity < 255;
        } else {
            this._contentPending = false;
            this._content.ease({
                opacity: 0,
                duration: CONTENT_FADE_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
        if (onComplete)
            this._settleCallbacks.push(onComplete);
        this._wake();
    }

    destroy() {
        GLib.source_remove(this._pollId);
        this._ticker.stop();
        this._clearHoverTimeout();
        this._grab?.dismiss();
        this._grab = null;
        if (this._stageEventId)
            global.stage.disconnect(this._stageEventId);
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
                    spec: {
                        icon: icon ? new Gio.ThemedIcon({name: icon}) : null,
                        text: title,
                        body,
                    },
                    timeout: timeoutMs,
                });
            }),
            proxy.connectSignal('StatusRequested', (_p, _sender, [id, icon, text, trail, color, timeoutMs]) => {
                this._enqueue({
                    id,
                    spec: {
                        icon: icon ? new Gio.ThemedIcon({name: icon}) : null,
                        iconColor: color,
                        text,
                        trail,
                        trailColor: color,
                        trailMono: true,
                    },
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
            this._pill.setItem(this._lastContent);
            this._pill.refresh();
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
            return item.spec;

        let body = notification.body ?? '';
        if (notification.useBodyMarkup)
            body = body.replace(/<[^>]*>/g, '');
        // Compact line: icon and title, with the sending app on the right
        return {
            icon: notification.gicon ?? notification.source?.icon ?? null,
            text: notification.title || notification.source?.title || '',
            trail: notification.title ? notification.source?.title ?? '' : '',
            trailColor: 'muted',
            body: body.replace(/\s+/g, ' ').trim(),
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
        this._pill.setItem(this._lastContent);
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
            this._pill.setItem(this._lastContent ?? {text: 'No notifications'});
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
