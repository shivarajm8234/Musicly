# Musicly

A feature-rich, modern MPRIS media controller extension for the GNOME Shell top panel.

Musicly integrates directly into your GNOME desktop environment, providing seamless playback control, animated status visualization, and comprehensive media metadata display across all active MPRIS-compatible audio and video players.

---

## Features

- **Top Bar Integration**: Compact, unobtrusive top panel widget displaying current track title, artist name, and player branding.
- **Dynamic Equalizer Visualization**: Real-time animated equalizer bars in the top bar that indicate active playback status.
- **Rich Popup Player Card**:
  - High-resolution album artwork display with graceful placeholder fallbacks.
  - Interactive scrub bar / progress timeline with accurate position tracking and seeking.
  - Full playback controls: Play/Pause, Next Track, Previous Track, Shuffle, and Loop/Repeat modes.
  - Dedicated volume slider with mouse scroll wheel support.
  - Player switcher dropdown allowing immediate switching between multiple concurrent media sources (e.g., Spotify, Chrome, Firefox, VLC).
- **Multi-Player MPRIS Architecture**: Automatically discovers and tracks all running MPRIS D-Bus interfaces. Gracefully handles dynamic player lifecycles, tab closures, and multi-tab browser playback.
- **Clean Text Formatting**: Automatically sanitizes track titles and artist strings to prevent visual corruption across desktop themes.
- **Lightweight & Efficient**: Optimized D-Bus query intervals and lightweight Clutter/St rendering to minimize CPU and battery usage.

---

## Compatibility

- **GNOME Shell**: 45, 46, 47, 48, 49, 50
- **Display Servers**: Wayland and X11
- **Supported Players**: Spotify, Google Chrome, Mozilla Firefox, Brave Browser, Chromium, Apple Music (Cider), Amberol, Celluloid, VLC Media Player, Rhythmbox, Elisa, Lollypop, and any standard MPRIS2-compliant application.

---

## Installation

### Method 1: Manual Installation from Source

1. Clone the repository into your local GNOME Shell extensions directory:

```bash
git clone https://github.com/shivarajm8234/Musicly.git ~/.local/share/gnome-shell/extensions/media-controller@satoru.local
```

2. If you already have the repository cloned elsewhere:

```bash
mkdir -p ~/.local/share/gnome-shell/extensions/
cp -r media-controller ~/.local/share/gnome-shell/extensions/media-controller@satoru.local
```

3. Restart GNOME Shell:
   - **X11**: Press `Alt + F2`, type `r`, and press `Enter`.
   - **Wayland**: Log out of your session and log back in.

4. Enable the extension:

```bash
gnome-extensions enable media-controller@satoru.local
```

Alternatively, open the **Extensions** or **Extension Manager** application and toggle **Musicly** on.

---

## Usage

- **Playback Indicator**: When audio or video is playing in a supported app, the track information and animated equalizer will appear in the top panel.
- **Open Controls**: Click the top panel indicator to open the complete control popup.
- **Seeking**: Click or drag along the progress bar to seek to a specific position in the track.
- **Volume**: Adjust volume using the slider in the popup or by scrolling over the volume controls.
- **Switching Players**: When multiple players are active, use the player selection menu at the top of the popup card to switch focus.

---

## Project Structure

```
├── metadata.json       # Extension metadata and GNOME Shell version targets
├── extension.js        # Main extension logic, MPRIS client, and UI widgets
├── prefs.js            # Preferences window settings handler
├── stylesheet.css      # Styling definitions for top panel and popup menu
└── README.md           # Project documentation
```

---

## Development & Debugging

To view live extension logs and debug MPRIS D-Bus communication:

```bash
journalctl -f -o cat /usr/bin/gnome-shell | grep -i "Musicly"
```

To test changes live during development:

```bash
gnome-extensions disable media-controller@satoru.local
gnome-extensions enable media-controller@satoru.local
```

---

## Contributing

Contributions are welcome. Please follow these guidelines:

1. Fork the repository.
2. Create a descriptive feature branch: `git checkout -b feature/your-feature-name`.
3. Ensure code adheres to standard GNOME JavaScript (GJS) coding conventions and ESM module syntax.
4. Commit your changes with clear, concise messages.
5. Push your branch and open a Pull Request.

---

## License

This project is licensed under the GNU General Public License v3.0 (GPL-3.0) or later.
