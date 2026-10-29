import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

// Music players over MPRIS. GNOME's own MprisPlayer has no track position, so the notch
// keeps its own small client.

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_INTERFACE = 'org.mpris.MediaPlayer2.Player';

const PlayerIface = `
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <method name="PlayPause"/>
    <method name="Next"/>
    <method name="Previous"/>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <signal name="Seeked">
      <arg type="x" name="position"/>
    </signal>
  </interface>
</node>`;

const AppIface = `
<node>
  <interface name="org.mpris.MediaPlayer2">
    <method name="Raise"/>
    <property name="Identity" type="s" access="read"/>
  </interface>
</node>`;

const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(PlayerIface);
const AppProxy = Gio.DBusProxy.makeProxyWrapper(AppIface);

class Player extends Signals.EventEmitter {
    constructor(busName) {
        super();
        this.busName = busName;
        // When it last started playing, to pick the player the user cares about
        this.lastPlayed = 0;
        this.title = '';
        this.artist = '';
        this.artUrl = '';
        this.length = 0;
        this.playing = false;
        this._trackId = null;
        this._position = 0;
        this._positionAt = GLib.get_monotonic_time();
        this._cancellable = new Gio.Cancellable();

        this._app = new AppProxy(Gio.DBus.session, busName, MPRIS_PATH, null, this._cancellable);
        this._player = new PlayerProxy(Gio.DBus.session, busName, MPRIS_PATH,
            (proxy, error) => {
                if (error)
                    return;
                proxy.connectObject('g-properties-changed', () => this._update(), this);
                this._seekedId = proxy.connectSignal('Seeked', (_p, _sender, [position]) => {
                    this._setPosition(position);
                    this.emit('changed');
                });
                this._update();
            }, this._cancellable);
    }

    get canGoNext() {
        return !!this._player.CanGoNext;
    }

    get canGoPrevious() {
        return !!this._player.CanGoPrevious;
    }

    get identity() {
        return this._app.Identity ?? '';
    }

    // Track position in microseconds, running on between the player's reports
    get position() {
        let position = this._position;
        if (this.playing)
            position += GLib.get_monotonic_time() - this._positionAt;
        return this.length > 0 ? Math.min(position, this.length) : position;
    }

    playPause() {
        this._player.PlayPauseRemote();
    }

    next() {
        this._player.NextRemote();
    }

    previous() {
        this._player.PreviousRemote();
    }

    raise() {
        this._app.RaiseRemote();
    }

    // Position is not announced as it changes, so it has to be asked for
    refreshPosition() {
        Gio.DBus.session.call(this.busName, MPRIS_PATH, 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [PLAYER_INTERFACE, 'Position']), null,
            Gio.DBusCallFlags.NONE, -1, this._cancellable, (connection, result) => {
                try {
                    const [value] = connection.call_finish(result).deepUnpack();
                    this._setPosition(Number(value.deepUnpack()));
                    this.emit('changed');
                } catch (e) {
                    // Not every player reports a position
                }
            });
    }

    _setPosition(position) {
        this._position = Number(position);
        this._positionAt = GLib.get_monotonic_time();
    }

    _update() {
        const metadata = {};
        for (const [key, value] of Object.entries(this._player.Metadata ?? {}))
            metadata[key] = value.deepUnpack();

        const artists = metadata['xesam:artist'];
        this.title = typeof metadata['xesam:title'] === 'string' ? metadata['xesam:title'] : '';
        this.artist = Array.isArray(artists) ? artists.filter(a => typeof a === 'string').join(', ') : '';
        this.artUrl = typeof metadata['mpris:artUrl'] === 'string' ? metadata['mpris:artUrl'] : '';
        this.length = Number(metadata['mpris:length'] ?? 0) || 0;

        const playing = this._player.PlaybackStatus === 'Playing';
        if (playing && !this.playing)
            this.lastPlayed = GLib.get_monotonic_time();
        if (playing !== this.playing) {
            // Freeze or restart the running position at the moment the state flips
            this._setPosition(this.position);
            this.playing = playing;
        }

        const trackId = metadata['mpris:trackid'] ?? this.title;
        if (trackId !== this._trackId) {
            this._trackId = trackId;
            this._setPosition(0);
            this.refreshPosition();
        }
        this.emit('changed');
    }

    destroy() {
        this._cancellable.cancel();
        this._player.disconnectObject(this);
        if (this._seekedId)
            this._player.disconnectSignal(this._seekedId);
    }
}

export class MediaWatcher extends Signals.EventEmitter {
    constructor() {
        super();
        this._players = new Map();
        this._cancellable = new Gio.Cancellable();

        this._ownerChangedId = Gio.DBus.session.signal_subscribe('org.freedesktop.DBus',
            'org.freedesktop.DBus', 'NameOwnerChanged', '/org/freedesktop/DBus', null,
            Gio.DBusSignalFlags.NONE, (_conn, _sender, _path, _iface, _signal, params) => {
                const [name, oldOwner, newOwner] = params.deepUnpack();
                if (!name.startsWith(MPRIS_PREFIX))
                    return;
                if (oldOwner)
                    this._removePlayer(name);
                if (newOwner)
                    this._addPlayer(name);
            });

        Gio.DBus.session.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'ListNames', null, null, Gio.DBusCallFlags.NONE, -1, this._cancellable, (connection, result) => {
                try {
                    const [names] = connection.call_finish(result).deepUnpack();
                    names.filter(name => name.startsWith(MPRIS_PREFIX)).forEach(name => this._addPlayer(name));
                } catch (e) {
                    console.warn(`Notchline: cannot list media players: ${e.message}`);
                }
            });
    }

    // The player to show: the one playing most recently, else the last paused one
    get current() {
        const players = [...this._players.values()].filter(player => player.title);
        const playing = players.filter(player => player.playing);
        const pool = playing.length ? playing : players;
        return pool.reduce((best, player) => (!best || player.lastPlayed > best.lastPlayed ? player : best), null);
    }

    _addPlayer(busName) {
        if (this._players.has(busName))
            return;
        const player = new Player(busName);
        player.connect('changed', () => this.emit('changed'));
        this._players.set(busName, player);
    }

    _removePlayer(busName) {
        const player = this._players.get(busName);
        if (!player)
            return;
        player.destroy();
        this._players.delete(busName);
        this.emit('changed');
    }

    destroy() {
        this._cancellable.cancel();
        Gio.DBus.session.signal_unsubscribe(this._ownerChangedId);
        this._players.forEach(player => player.destroy());
        this._players.clear();
    }
}
