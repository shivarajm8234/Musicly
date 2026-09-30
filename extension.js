import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Mpris from 'resource:///org/gnome/shell/ui/mpris.js';

// D-Bus interface for querying player position, playback controls, volume
const MprisPlayerIface = `
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <property name="Position" type="x" access="read"/>
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata" type="a{sv}" access="read"/>
    <property name="Shuffle" type="b" access="readwrite"/>
    <property name="LoopStatus" type="s" access="readwrite"/>
    <property name="Volume" type="d" access="readwrite"/>
    <property name="CanControl" type="b" access="read"/>
    <property name="CanPlay" type="b" access="read"/>
    <property name="CanPause" type="b" access="read"/>
    <property name="CanGoNext" type="b" access="read"/>
    <property name="CanGoPrevious" type="b" access="read"/>
    <method name="PlayPause"/>
    <method name="Play"/>
    <method name="Pause"/>
    <method name="Stop"/>
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Seek">
      <arg direction="in" type="x" name="Offset"/>
    </method>
    <method name="SetPosition">
      <arg direction="in" type="o" name="TrackId"/>
      <arg direction="in" type="x" name="Position"/>
    </method>
  </interface>
</node>`;
const MprisPlayerProxy = Gio.DBusProxy.makeProxyWrapper(MprisPlayerIface);

function removeEmoji(str) {
    if (!str) return str;
    return str.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '');
}

const APP_IDENTIFIERS = [
    { match: 'brave',       name: 'Brave',        icon: 'brave-browser-symbolic' },
    { match: 'chrome',      name: 'Chrome',       icon: 'google-chrome-symbolic' },
    { match: 'chromium',    name: 'Chromium',     icon: 'google-chrome-symbolic' },
    { match: 'firefox',     name: 'Firefox',      icon: 'firefox-symbolic' },
    { match: 'spotify',     name: 'Spotify',      icon: 'spotify-symbolic' },
    { match: 'vlc',         name: 'VLC',          icon: 'vlc-symbolic' },
    { match: 'rhythmbox',   name: 'Rhythmbox',    icon: 'rhythmbox-symbolic' },
    { match: 'youtube',     name: 'YouTube Music', icon: 'multimedia-player-symbolic' },
    { match: 'ytmusic',     name: 'YouTube Music', icon: 'multimedia-player-symbolic' },
    { match: 'cider',       name: 'Apple Music',  icon: 'multimedia-player-symbolic' },
    { match: 'amberol',     name: 'Amberol',      icon: 'io.bassi.Amberol-symbolic' },
    { match: 'celluloid',   name: 'Celluloid',    icon: 'io.github.celluloid_player.Celluloid-symbolic' },
    { match: 'elisa',       name: 'Elisa',        icon: 'elisa-symbolic' },
    { match: 'lollypop',    name: 'Lollypop',     icon: 'org.gnome.Lollypop-symbolic' },
];

function getAppInfo(player) {
    const busName = player?.busName || player?._busName || '';
    const cleanBus = busName.replace('org.mpris.MediaPlayer2.', '');
    const lower = cleanBus.toLowerCase();

    // Check bus name against known apps
    const known = APP_IDENTIFIERS.find(entry => lower.includes(entry.match));
    if (known) return { name: known.name, iconName: known.icon, isAppIcon: false };

    // Fallback to app info from the desktop entry
    if (player?.app) {
        const name = player.app.get_name();
        const appIcon = player.app.get_icon();
        if (appIcon) return { name, iconName: appIcon.to_string(), isAppIcon: true };
        return { name, iconName: 'audio-x-generic-symbolic', isAppIcon: false };
    }

    // Last resort: derive name from bus name
    if (cleanBus) {
        const base = cleanBus.split('.')[0];
        const name = base.charAt(0).toUpperCase() + base.slice(1);
        return { name, iconName: 'audio-x-generic-symbolic', isAppIcon: false };
    }

    return { name: 'Media Player', iconName: 'audio-x-generic-symbolic', isAppIcon: false };
}

const MediaIndicator = GObject.registerClass(
class MediaIndicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, _('Musicly'));

        // State
        this._isDestroyed = false;
        this._players = new Map();
        this._playerSignals = new Map();
        this._activePlayer = null;
        this._playerProxy = null;
        this._positionTimerId = 0;
        this._topEqTimerId = 0;
        this._trackLength = 0;
        this._currentPosition = 0;
        this._shuffleOn = false;
        this._loopStatus = 'None';
        this._eqStep = 0;
        this._lastCoverUrl = null;

        // ── Top Bar Container ──
        this._topContainer = new St.BoxLayout({
            style_class: 'media-top-container',
            vertical: false,
            reactive: true,
            track_hover: true,
        });

        // ── Top Bar Left: Info Area (Clicking opens Popup) ──
        this._topInfoArea = new St.BoxLayout({
            style_class: 'media-top-info-area',
            vertical: false,
            reactive: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        // Animated Mini Equalizer Bars for Top Bar
        this._topEqBox = new St.BoxLayout({
            style_class: 'media-top-eq-box',
            vertical: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._topEqBars = [];
        for (let i = 0; i < 4; i++) {
            const bar = new St.Widget({
                style_class: 'media-top-eq-bar',
                y_align: Clutter.ActorAlign.END,
            });
            bar.set_height(4);
            bar.set_width(3);
            this._topEqBars.push(bar);
            this._topEqBox.add_child(bar);
        }

        // Top Bar Label
        this._topLabel = new St.Label({
            text: _('No Media'),
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'media-top-label',
        });
        this._topLabel.clutter_text.set_ellipsize(3);

        this._topInfoArea.add_child(this._topEqBox);
        this._topInfoArea.add_child(this._topLabel);

        // ── Top Bar Right: Inline Controls (Stop, Prev, Play/Pause, Next) ──
        this._topControlsBox = new St.BoxLayout({
            style_class: 'media-top-controls-box',
            vertical: false,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._topPrevIcon = new St.Icon({
            icon_name: 'media-skip-backward-symbolic',
            icon_size: 13,
            style_class: 'media-top-btn-icon',
        });
        this._topPrevBtn = this._createTopBtn(this._topPrevIcon, () => {
            if (this._activePlayer) this._activePlayer.previous();
        });

        this._topPlayPauseIcon = new St.Icon({
            icon_name: 'media-playback-start-symbolic',
            icon_size: 13,
            style_class: 'media-top-btn-icon',
        });
        this._topPlayPauseBtn = this._createTopBtn(this._topPlayPauseIcon, () => {
            if (this._activePlayer) this._activePlayer.playPause();
        });
        this._topPlayPauseBtn.add_style_class_name('media-top-play-btn');

        this._topNextIcon = new St.Icon({
            icon_name: 'media-skip-forward-symbolic',
            icon_size: 13,
            style_class: 'media-top-btn-icon',
        });
        this._topNextBtn = this._createTopBtn(this._topNextIcon, () => {
            if (this._activePlayer) this._activePlayer.next();
        });

        this._topControlsBox.add_child(this._topPrevBtn);
        this._topControlsBox.add_child(this._topPlayPauseBtn);
        this._topControlsBox.add_child(this._topNextBtn);

        this._topContainer.add_child(this._topInfoArea);
        this._topContainer.add_child(this._topControlsBox);

        this.add_child(this._topContainer);

        // Build popup
        this._buildMenu();

        // MPRIS source tracking
        this._mprisSource = new Mpris.MprisSource();
        this._mprisAddedSigId = this._mprisSource.connect('player-added', this._onPlayerAdded.bind(this));
        this._mprisRemovedSigId = this._mprisSource.connect('player-removed', this._onPlayerRemoved.bind(this));

        // Also watch D-Bus directly for MPRIS name changes we might miss
        this._dbusWatchId = Gio.DBus.session.signal_subscribe(
            'org.freedesktop.DBus',
            'org.freedesktop.DBus',
            'NameOwnerChanged',
            '/org/freedesktop/DBus',
            null,
            Gio.DBusSignalFlags.NONE,
            (_conn, _sender, _path, _iface, _signal, params) => {
                if (this._isDestroyed) return;
                const [name, oldOwner, newOwner] = params.deepUnpack();
                if (!name.startsWith('org.mpris.MediaPlayer2.')) return;
                // Give MprisSource a moment to process, then re-sync
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                    if (this._isDestroyed) return GLib.SOURCE_REMOVE;
                    this._syncPlayersFromSource();
                    return GLib.SOURCE_REMOVE;
                });
            }
        );

        // Initial sync after a short delay to catch already-running players
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            if (this._isDestroyed) return GLib.SOURCE_REMOVE;
            this._syncPlayersFromSource();
            return GLib.SOURCE_REMOVE;
        });

        // Start top animation loop
        this._startTopEqAnimation();
    }

    _createTopBtn(icon, callback) {
        const btn = new St.Button({
            style_class: 'media-top-btn',
            child: icon,
            can_focus: true,
            reactive: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        // Intercept click to prevent panel menu toggling
        btn.connect('button-press-event', (_actor, _event) => {
            return Clutter.EVENT_STOP;
        });

        btn.connect('button-release-event', (_actor, event) => {
            if (event.get_button() === 1) {
                callback();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        return btn;
    }

    _buildMenu() {
        this.menu.removeAll();

        // Main popup card
        const mainItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'media-popup-base-item',
        });

        this._popupCard = new St.BoxLayout({
            style_class: 'media-popup-card',
            vertical: true,
        });

        // ── 1. Header: Multiple Players / Tabs Selector ──
        this._sourcesSection = new St.BoxLayout({
            style_class: 'media-sources-section',
            vertical: true,
        });

        this._sourcesHeaderBox = new St.BoxLayout({
            style_class: 'media-sources-header',
            vertical: false,
        });

        const sourcesTitle = new St.Label({
            text: _('Active Sources'),
            style_class: 'media-sources-title',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });

        this._playerCountBadge = new St.Label({
            text: '0',
            style_class: 'media-sources-badge',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._sourcesHeaderBox.add_child(sourcesTitle);
        this._sourcesHeaderBox.add_child(this._playerCountBadge);

        // Horizontal pill container for switching between multiple tabs / players
        this._sourcesPillsBox = new St.BoxLayout({
            style_class: 'media-sources-pills-box',
            vertical: true,
            x_expand: true,
        });

        this._sourcesSection.add_child(this._sourcesHeaderBox);
        this._sourcesSection.add_child(this._sourcesPillsBox);

        // ── 2. Player Body (Artwork + Info + Equalizer) ──
        this._playerBody = new St.BoxLayout({
            style_class: 'media-player-body',
            vertical: false,
        });

        // Album Art container
        this._albumArtContainer = new St.Bin({
            style_class: 'media-album-art-container',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._albumIconFallback = new St.Icon({
            icon_name: 'audio-x-generic-symbolic',
            icon_size: 48,
            style_class: 'media-album-fallback-icon',
        });
        this._albumArtContainer.set_child(this._albumIconFallback);

        // Right details area
        this._detailsBox = new St.BoxLayout({
            style_class: 'media-details-box',
            vertical: true,
            x_expand: true,
        });

        // App badge & Track Info
        this._appBadge = new St.Label({
            text: '',
            style_class: 'media-app-badge',
        });

        this._titleLabel = new St.Label({
            text: _('No Media Playing'),
            style_class: 'media-popup-title',
            x_expand: true,
        });
        this._titleLabel.clutter_text.set_ellipsize(3);

        this._artistLabel = new St.Label({
            text: '',
            style_class: 'media-popup-artist',
            x_expand: true,
        });
        this._artistLabel.clutter_text.set_ellipsize(3);

        // Visualizer equalizer bars in popup
        this._visualizerBox = new St.BoxLayout({
            style_class: 'media-popup-visualizer',
            vertical: false,
            x_align: Clutter.ActorAlign.FILL,
            x_expand: true,
        });
        this._visualizerBars = [];
        for (let i = 0; i < 28; i++) {
            const bar = new St.Widget({
                style_class: 'media-popup-visualizer-bar',
                y_align: Clutter.ActorAlign.END,
            });
            bar.set_height(4);
            bar.set_width(3);
            this._visualizerBars.push(bar);
            this._visualizerBox.add_child(bar);
        }

        this._detailsBox.add_child(this._appBadge);
        this._detailsBox.add_child(this._titleLabel);
        this._detailsBox.add_child(this._artistLabel);
        this._detailsBox.add_child(this._visualizerBox);

        this._playerBody.add_child(this._albumArtContainer);
        this._playerBody.add_child(this._detailsBox);

        // ── 3. Progress / Seek Bar ──
        this._progressContainer = new St.BoxLayout({
            style_class: 'media-progress-container',
            vertical: false,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._posLabel = new St.Label({
            text: '0:00',
            style_class: 'media-time-text',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._durLabel = new St.Label({
            text: '0:00',
            style_class: 'media-time-text',
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._sliderTrack = new St.Bin({
            style_class: 'media-progress-track',
            reactive: true,
            can_focus: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._sliderFill = new St.Widget({
            style_class: 'media-progress-fill',
        });
        this._sliderTrack.set_child(this._sliderFill);

        // Seek interaction
        this._sliderTrack.connect('button-press-event', (actor, event) => {
            const [ok, x] = event.get_coords();
            if (ok) {
                const [ax] = actor.get_transformed_position();
                const w = actor.get_width();
                if (w > 0) {
                    const fraction = Math.max(0, Math.min(1, (x - ax) / w));
                    this._seekToFraction(fraction);
                }
            }
            return Clutter.EVENT_STOP;
        });

        this._progressContainer.add_child(this._posLabel);
        this._progressContainer.add_child(this._sliderTrack);
        this._progressContainer.add_child(this._durLabel);

        // ── 4. Popup Controls Deck ──
        this._popupControls = new St.BoxLayout({
            style_class: 'media-popup-controls',
            vertical: false,
            x_align: Clutter.ActorAlign.CENTER,
        });

        this._shuffleIcon = new St.Icon({ icon_name: 'media-playlist-shuffle-symbolic', icon_size: 16 });
        this._shuffleBtn = this._createPopupBtn(this._shuffleIcon, () => this._toggleShuffle());

        this._prevIcon = new St.Icon({ icon_name: 'media-skip-backward-symbolic', icon_size: 16 });
        this._prevBtn = this._createPopupBtn(this._prevIcon, () => {
            if (this._activePlayer) this._activePlayer.previous();
        });

        this._playPauseIcon = new St.Icon({ icon_name: 'media-playback-start-symbolic', icon_size: 16 });
        this._playPauseBtn = this._createPopupBtn(this._playPauseIcon, () => {
            if (this._activePlayer) this._activePlayer.playPause();
        });
        this._playPauseBtn.add_style_class_name('media-popup-play-btn');

        this._nextIcon = new St.Icon({ icon_name: 'media-skip-forward-symbolic', icon_size: 16 });
        this._nextBtn = this._createPopupBtn(this._nextIcon, () => {
            if (this._activePlayer) this._activePlayer.next();
        });

        this._loopIcon = new St.Icon({ icon_name: 'media-playlist-repeat-symbolic', icon_size: 16 });
        this._loopBtn = this._createPopupBtn(this._loopIcon, () => this._toggleLoop());

        this._popupControls.add_child(this._shuffleBtn);
        this._popupControls.add_child(this._prevBtn);
        this._popupControls.add_child(this._playPauseBtn);
        this._popupControls.add_child(this._nextBtn);
        this._popupControls.add_child(this._loopBtn);

        // Assemble entire popup
        this._popupCard.add_child(this._sourcesSection);
        this._popupCard.add_child(this._playerBody);
        this._popupCard.add_child(this._progressContainer);
        this._popupCard.add_child(this._popupControls);

        mainItem.add_child(this._popupCard);
        this.menu.addMenuItem(mainItem);
    }

    _createPopupBtn(icon, callback) {
        const btn = new St.Button({
            style_class: 'media-popup-control-btn',
            child: icon,
            can_focus: true,
            reactive: true,
            track_hover: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        btn.connect('clicked', callback);
        return btn;
    }

    // ── Player Management ──

    _onPlayerAdded(_source, player) {
        if (this._isDestroyed) return;
        const busName = player.busName || player._busName;
        if (this._players.has(busName)) return;

        this._players.set(busName, player);

        const sigId = player.connect('changed', () => {
            this._onPlayerChanged(player);
        });
        this._playerSignals.set(busName, sigId);

        // Auto promote playing player
        if (!this._activePlayer || player.status === 'Playing') {
            this._setActivePlayer(player);
        }

        this._updateSourcesList();
        this._syncUI();
    }

    _onPlayerRemoved(_source, player) {
        if (this._isDestroyed) return;
        const busName = player.busName || player._busName;
        if (this._playerSignals.has(busName)) {
            try { player.disconnect(this._playerSignals.get(busName)); } catch (_) {}
            this._playerSignals.delete(busName);
        }
        this._players.delete(busName);

        if (this._activePlayer === player) {
            // Prefer a playing player, otherwise take the first available
            let nextPlayer = null;
            for (const p of this._players.values()) {
                if (p.status === 'Playing') {
                    nextPlayer = p;
                    break;
                }
            }
            if (!nextPlayer) {
                const iter = this._players.values().next();
                nextPlayer = iter.done ? null : iter.value;
            }
            this._setActivePlayer(nextPlayer);
        }

        this._updateSourcesList();
        this._syncUI();
    }

    _onPlayerChanged(player) {
        if (this._isDestroyed) return;
        if (player === this._activePlayer) {
            this._readProxyState();
            this._syncUI();
        } else if (player.status === 'Playing' && (!this._activePlayer || this._activePlayer.status !== 'Playing')) {
            this._setActivePlayer(player);
        }
        this._updateSourcesList();
    }

    // Re-sync players from MprisSource to catch any we missed
    _syncPlayersFromSource() {
        if (this._isDestroyed || !this._mprisSource) return;

        const sourcePlayers = this._mprisSource.players || [];
        const currentBusNames = new Set(this._players.keys());

        for (const player of sourcePlayers) {
            const busName = player.busName || player._busName;
            if (!currentBusNames.has(busName)) {
                this._onPlayerAdded(this._mprisSource, player);
            }
        }
    }

    _setActivePlayer(player) {
        if (this._isDestroyed) return;
        this._activePlayer = player;
        this._destroyPlayerProxy();

        if (player) {
            try {
                this._playerProxy = new MprisPlayerProxy(
                    Gio.DBus.session,
                    player.busName || player._busName,
                    '/org/mpris/MediaPlayer2',
                    (proxy, error) => {
                        if (error || this._isDestroyed) return;
                        this._readProxyState();
                        proxy.connect('g-properties-changed', () => {
                            if (!this._isDestroyed) this._readProxyState();
                        });
                    }
                );
            } catch (_) {}
        }

        this._syncUI();
        this._startPositionTimer();
        this._updateSourcesList();
    }

    _destroyPlayerProxy() {
        if (this._playerProxy) {
            try { this._playerProxy.disconnectObject?.(this); } catch (_) {}
            this._playerProxy = null;
        }
    }

    _readProxyState() {
        if (this._isDestroyed || !this._playerProxy) return;
        try {
            const meta = this._playerProxy.Metadata;
            if (meta && meta['mpris:length']) {
                let len = meta['mpris:length'];
                // Unpack GLib.Variant if needed
                if (len && typeof len.deepUnpack === 'function')
                    len = len.deepUnpack();
                this._trackLength = (typeof len === 'number' && isFinite(len)) ? len : 0;
            } else {
                this._trackLength = 0;
            }
        } catch (_) {
            this._trackLength = 0;
        }

        try {
            this._shuffleOn = !!this._playerProxy.Shuffle;
        } catch (_) { this._shuffleOn = false; }

        try {
            this._loopStatus = this._playerProxy.LoopStatus ?? 'None';
        } catch (_) { this._loopStatus = 'None'; }
        
        try {
            this._currentVolume = this._playerProxy.Volume ?? 1.0;
        } catch (_) { this._currentVolume = 1.0; }

        this._syncUI();
    }

    // ── Animation & Timers ──

    _startPositionTimer() {
        this._stopPositionTimer();
        if (!this._activePlayer || this._isDestroyed) return;

        this._positionTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            if (this._isDestroyed) return GLib.SOURCE_REMOVE;
            this._updatePosition();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopPositionTimer() {
        if (this._positionTimerId) {
            GLib.source_remove(this._positionTimerId);
            this._positionTimerId = 0;
        }
    }

    _startTopEqAnimation() {
        if (this._topEqTimerId) return;
        this._topEqTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 120, () => {
            if (this._isDestroyed) return GLib.SOURCE_REMOVE;
            const isPlaying = this._activePlayer && this._activePlayer.status === 'Playing';
            this._eqStep++;

            // Animate Top Bar Equalizer
            const topHeights = isPlaying
                ? [
                    Math.floor(4 + Math.sin(this._eqStep * 0.5) * 6 + 4),
                    Math.floor(4 + Math.cos(this._eqStep * 0.7) * 7 + 4),
                    Math.floor(4 + Math.sin(this._eqStep * 0.9 + 1) * 6 + 4),
                    Math.floor(4 + Math.cos(this._eqStep * 0.4 + 2) * 8 + 4),
                  ]
                : [3, 3, 3, 3];

            for (let i = 0; i < this._topEqBars.length; i++) {
                this._topEqBars[i].set_height(Math.max(3, Math.min(16, topHeights[i])));
                if (isPlaying) {
                    this._topEqBars[i].add_style_class_name('media-top-eq-active');
                } else {
                    this._topEqBars[i].remove_style_class_name('media-top-eq-active');
                }
            }

            // Animate Popup Visualizer
            if (this.menu && this.menu.isOpen) {
                for (let i = 0; i < this._visualizerBars.length; i++) {
                    const h = isPlaying
                        ? Math.floor(4 + Math.abs(Math.sin((this._eqStep + i * 2) * 0.35)) * 18)
                        : 4;
                    this._visualizerBars[i].set_height(h);
                }
            }

            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTopEqAnimation() {
        if (this._topEqTimerId) {
            GLib.source_remove(this._topEqTimerId);
            this._topEqTimerId = 0;
        }
    }

    _updatePosition() {
        if (this._isDestroyed || !this._playerProxy) return;

        try {
            const busName = this._playerProxy.get_name();
            const objPath = this._playerProxy.get_object_path();
            
            this._playerProxy.get_connection().call(
                busName,
                objPath,
                'org.freedesktop.DBus.Properties',
                'Get',
                new GLib.Variant('(ss)', ['org.mpris.MediaPlayer2.Player', 'Position']),
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                (conn, res) => {
                    if (this._isDestroyed) return;
                    try {
                        let reply = conn.call_finish(res);
                        if (reply) {
                            // reply is (v), deepUnpack gives the inner variant
                            let val = reply.deepUnpack();
                            // Unwrap nested variant/array
                            if (val && typeof val.deepUnpack === 'function')
                                val = val.deepUnpack();
                            else if (Array.isArray(val) && val.length > 0)
                                val = val[0];
                            // Further unwrap if still a GLib.Variant
                            if (val && typeof val.deepUnpack === 'function')
                                val = val.deepUnpack();

                            const pos = Number(val);
                            if (isFinite(pos)) {
                                this._currentPosition = pos;
                                this._syncProgressBar();
                            }
                        }
                    } catch(e) {}
                }
            );
        } catch (e) {}
    }

    _seekToFraction(fraction) {
        if (!this._playerProxy || this._trackLength <= 0) return;
        const targetUs = Math.round(fraction * this._trackLength);

        try {
            const meta = this._playerProxy.Metadata;
            if (meta && meta['mpris:trackid']) {
                const trackId = meta['mpris:trackid'].deepUnpack();
                if (this._playerProxy.SetPositionAsync) {
                    this._playerProxy.SetPositionAsync(trackId, targetUs).catch(() => {});
                } else if (this._playerProxy.SetPositionRemote) {
                    this._playerProxy.SetPositionRemote(trackId, targetUs);
                } else {
                    this._playerProxy.SetPositionSync(trackId, targetUs);
                }
            }
        } catch (_) {}

        this._currentPosition = targetUs;
        this._syncProgressBar();
    }

    _toggleShuffle() {
        if (!this._playerProxy) return;
        try {
            this._shuffleOn = !this._shuffleOn;
            this._playerProxy.Shuffle = this._shuffleOn;
            this._syncShuffleLoop();
        } catch (_) {}
    }

    _toggleLoop() {
        if (!this._playerProxy) return;
        try {
            const states = ['None', 'Track', 'Playlist'];
            const idx = states.indexOf(this._loopStatus);
            this._loopStatus = states[(idx + 1) % states.length];
            this._playerProxy.LoopStatus = this._loopStatus;
            this._syncShuffleLoop();
        } catch (_) {}
    }

    // ── Multiple Sources / Tabs Selector ──

    _updateSourcesList() {
        if (this._isDestroyed) return;
        
        if (this._sourcesPillsBox.destroy_all_children) {
            this._sourcesPillsBox.destroy_all_children();
        } else if (this._sourcesPillsBox.remove_all_children) {
            this._sourcesPillsBox.remove_all_children();
        }
        
        const count = this._players.size;
        this._playerCountBadge.set_text(`${count}`);

        if (count === 0) {
            this._sourcesSection.hide();
            return;
        }

        this._sourcesSection.show();

        for (const [busName, player] of this._players) {
            const appInfo = getAppInfo(player);
            const isSelected = player === this._activePlayer;
            const isPlaying = player.status === 'Playing';

            const pillBtn = new St.Button({
                style_class: 'media-source-pill',
                can_focus: true,
                reactive: true,
                track_hover: true,
            });

            if (isSelected) pillBtn.add_style_class_name('media-source-pill-active');

            const pillBox = new St.BoxLayout({
                style_class: 'media-source-pill-box',
                vertical: false,
                y_align: Clutter.ActorAlign.CENTER,
            });

            // App Icon
            const icon = new St.Icon({
                icon_name: appInfo.iconName,
                icon_size: 14,
                style_class: 'media-source-pill-icon',
            });

            // Label: "App • Title preview"
            const trackTitleRaw = removeEmoji(player.trackTitle);
            const titlePreview = trackTitleRaw ? ` • ${trackTitleRaw}` : '';
            const pillLabel = new St.Label({
                text: `${appInfo.name}${titlePreview}`,
                style_class: 'media-source-pill-label',
                y_align: Clutter.ActorAlign.CENTER,
            });
            pillLabel.clutter_text.set_ellipsize(3);

            // Playing state indicator dot
            const statusDot = new St.Widget({
                style_class: isPlaying ? 'media-source-dot-playing' : 'media-source-dot-paused',
                y_align: Clutter.ActorAlign.CENTER,
            });

            pillBox.add_child(icon);
            pillBox.add_child(pillLabel);
            pillBox.add_child(statusDot);
            pillBtn.set_child(pillBox);

            pillBtn.connect('clicked', () => {
                this._setActivePlayer(player);
            });

            this._sourcesPillsBox.add_child(pillBtn);
        }
    }

    // ── Synchronize UI ──

    _syncUI() {
        if (this._isDestroyed) return;

        if (!this._activePlayer) {
            this._topLabel.set_text(_('No Media'));
            this._titleLabel.set_text(_('No Media Playing'));
            this._artistLabel.set_text('');
            this._appBadge.set_text('');
            this._albumArtContainer.set_child(this._albumIconFallback);

            this._topPlayPauseIcon.icon_name = 'media-playback-start-symbolic';
            this._playPauseIcon.icon_name = 'media-playback-start-symbolic';

            this._posLabel.set_text('0:00');
            this._durLabel.set_text('0:00');
            this._sliderFill.set_width(0);
            return;
        }

        const isPlaying = this._activePlayer.status === 'Playing';
        const title = removeEmoji(this._activePlayer.trackTitle) || _('Unknown Track');
        const artists = removeEmoji((this._activePlayer.trackArtists || []).join(', ')) || '';
        const appInfo = getAppInfo(this._activePlayer);

        // Top Bar Label
        const topText = artists ? `${title} — ${artists}` : title;
        this._topLabel.set_text(topText);

        // Top Bar Play/Pause Icon
        const playIconName = isPlaying ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
        this._topPlayPauseIcon.icon_name = playIconName;
        this._playPauseIcon.icon_name = playIconName;

        if (isPlaying) {
            this._topPlayPauseBtn.add_style_class_name('media-top-btn-playing');
        } else {
            this._topPlayPauseBtn.remove_style_class_name('media-top-btn-playing');
        }

        // Popup details
        this._appBadge.set_text(`${appInfo.name.toUpperCase()} • ${isPlaying ? _('PLAYING') : _('PAUSED')}`);
        this._titleLabel.set_text(title);
        this._artistLabel.set_text(artists);

        // Album Art
        const coverUrl = this._activePlayer.trackCoverUrl;
        if (coverUrl && coverUrl !== this._lastCoverUrl) {
            this._lastCoverUrl = coverUrl;
            try {
                const file = Gio.File.new_for_uri(coverUrl);
                if (file.query_exists(null)) {
                    // Use background-image CSS for bitmap art (JPEG/PNG from browsers)
                    const artBin = new St.Bin({
                        style_class: 'media-album-image',
                        style: `background-image: url("${coverUrl}"); background-size: cover; background-position: center; width: 96px; height: 96px;`,
                        x_align: Clutter.ActorAlign.CENTER,
                        y_align: Clutter.ActorAlign.CENTER,
                    });
                    this._albumArtContainer.set_child(artBin);
                } else {
                    this._albumArtContainer.set_child(this._albumIconFallback);
                }
            } catch (_) {
                this._albumArtContainer.set_child(this._albumIconFallback);
            }
        } else if (!coverUrl) {
            this._lastCoverUrl = null;
            this._albumArtContainer.set_child(this._albumIconFallback);
        }

        // Duration & Controls
        this._durLabel.set_text(this._formatTime(this._trackLength));
        this._syncProgressBar();
        this._syncShuffleLoop();
    }

    _syncProgressBar() {
        if (this._isDestroyed) return;
        if (this._trackLength <= 0) {
            this._sliderFill.set_width(0);
            this._posLabel.set_text('0:00');
            return;
        }
        const fraction = Math.max(0, Math.min(1, this._currentPosition / this._trackLength));
        const trackWidth = this._sliderTrack.get_width();
        if (trackWidth > 0)
            this._sliderFill.set_width(Math.round(fraction * trackWidth));

        this._posLabel.set_text(this._formatTime(this._currentPosition));
    }

    _syncShuffleLoop() {
        if (this._isDestroyed) return;
        if (this._shuffleOn)
            this._shuffleBtn.add_style_class_name('media-btn-active');
        else
            this._shuffleBtn.remove_style_class_name('media-btn-active');

        if (this._loopStatus === 'Track') {
            this._loopIcon.icon_name = 'media-playlist-repeat-song-symbolic';
            this._loopBtn.add_style_class_name('media-btn-active');
        } else if (this._loopStatus === 'Playlist') {
            this._loopIcon.icon_name = 'media-playlist-repeat-symbolic';
            this._loopBtn.add_style_class_name('media-btn-active');
        } else {
            this._loopIcon.icon_name = 'media-playlist-repeat-symbolic';
            this._loopBtn.remove_style_class_name('media-btn-active');
        }
    }

    _formatTime(us) {
        if (!us || !isFinite(us) || us < 0) return '0:00';
        const totalSec = Math.floor(Number(us) / 1000000);
        if (!isFinite(totalSec) || totalSec < 0) return '0:00';
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        if (h > 0)
            return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    destroy() {
        this._isDestroyed = true;
        this._stopPositionTimer();
        this._stopTopEqAnimation();
        this._destroyPlayerProxy();

        if (this._dbusWatchId) {
            Gio.DBus.session.signal_unsubscribe(this._dbusWatchId);
            this._dbusWatchId = 0;
        }

        if (this._mprisSource) {
            if (this._mprisAddedSigId) {
                try { this._mprisSource.disconnect(this._mprisAddedSigId); } catch (_) {}
                this._mprisAddedSigId = 0;
            }
            if (this._mprisRemovedSigId) {
                try { this._mprisSource.disconnect(this._mprisRemovedSigId); } catch (_) {}
                this._mprisRemovedSigId = 0;
            }
            this._mprisSource = null;
        }

        for (const [busName, sigId] of this._playerSignals) {
            const p = this._players.get(busName);
            if (p) {
                try { p.disconnect(sigId); } catch (_) {}
            }
        }
        this._playerSignals.clear();
        this._players.clear();

        super.destroy();
    }
});

export default class MusiclyExtension extends Extension {
    enable() {
        this._indicator = new MediaIndicator();
        // Place right beside Quick Settings / Wifi button on the right
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
