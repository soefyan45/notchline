import Gio from 'gi://Gio';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';
import * as Calendar from 'resource:///org/gnome/shell/ui/calendar.js';

// System sources shared by the panel and the compact notch: the battery (UPower) and
// today's calendar events (GNOME's calendar server, as used by the clock)

const UPowerDeviceIface = `
<node>
  <interface name="org.freedesktop.UPower.Device">
    <property name="Percentage" type="d" access="read"/>
    <property name="IsPresent" type="b" access="read"/>
    <property name="IconName" type="s" access="read"/>
    <property name="State" type="u" access="read"/>
  </interface>
</node>`;
const UPowerDeviceProxy = Gio.DBusProxy.makeProxyWrapper(UPowerDeviceIface);
const UPOWER_CHARGING = 1;
const UPOWER_FULLY_CHARGED = 4;
const DAY_MS = 24 * 3600 * 1000;

export class BatteryWatcher extends Signals.EventEmitter {
    constructor() {
        super();
        this._charging = null;
        this._proxy = new UPowerDeviceProxy(Gio.DBus.system, 'org.freedesktop.UPower',
            '/org/freedesktop/UPower/devices/DisplayDevice', (proxy, error) => {
                if (error)
                    return;
                proxy.connectObject('g-properties-changed', () => this._update(), this);
                this._update();
            });
    }

    get present() {
        return !!this._proxy?.IsPresent;
    }

    get percentage() {
        return Math.round(this._proxy?.Percentage ?? 0);
    }

    get iconName() {
        return this._proxy?.IconName || 'battery-symbolic';
    }

    get charging() {
        return [UPOWER_CHARGING, UPOWER_FULLY_CHARGED].includes(this._proxy?.State);
    }

    _update() {
        const charging = this.present && this.charging;
        // 'plugged' only for a change while running, not for the state at startup
        if (charging && this._charging === false)
            this.emit('plugged');
        this._charging = charging;
        this.emit('changed');
    }

    destroy() {
        this._proxy?.disconnectObject(this);
    }
}

export class CalendarWatcher extends Signals.EventEmitter {
    constructor() {
        super();
        this._source = new Calendar.DBusEventSource();
        this._source.connectObject('changed', () => this.emit('changed'), this);
        this.today();
    }

    // Today's events, loading them (again after midnight) when needed
    today() {
        const begin = new Date();
        begin.setHours(0, 0, 0, 0);
        const end = new Date(begin.getTime() + DAY_MS);
        this._source.requestRange(begin, end);
        return this._source.getEvents(begin, end);
    }

    destroy() {
        this._source.disconnectObject(this);
        this._source.destroy();
    }
}

export const isAllDay = event => event.end - event.date >= DAY_MS;
