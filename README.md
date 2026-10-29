<p align="center">
  <img src="extension/icons/notchline-symbol.svg" width="96" alt="Notchline logo">
</p>

# Notchline

A notch-style notification layer for GNOME, written in Rust.

Notifications appear as a pill at the top center of the screen that expands
when something arrives and shrinks back to a small notch afterwards.

## How it works

```
┌─────────────────────────────┐     D-Bus (session)     ┌──────────────────────────┐
│ GNOME Shell extension (GJS) │ ◄────────────────────── │ notchline (Rust daemon)  │
│ - renders the notch pill    │  ShowRequested/Dismiss  │ - config.toml            │
│ - captures GNOME notifs     │                         │ - CLI: notchline show .. │
└─────────────────────────────┘                         └──────────────────────────┘
```

On GNOME Wayland an app cannot place itself on top of the screen, so the UI
lives in a GNOME Shell extension. The Rust daemon owns the config and the CLI,
and talks to the extension over D-Bus (`io.github.soefyan45.Notchline`).

- `daemon/` — Rust daemon + CLI
- `extension/` — GNOME Shell extension (`notchline@soefyan45.github.io`)

## Requirements

- GNOME Shell 46 (tested on Zorin OS 18, Wayland)
- Rust toolchain (`cargo`)

## Install

```bash
# 1. Daemon + CLI
cargo install --path daemon
notchline install-service   # D-Bus activation: the daemon starts on demand

# 2. Extension
mkdir -p ~/.local/share/gnome-shell/extensions
ln -sfn "$PWD/extension" ~/.local/share/gnome-shell/extensions/notchline@soefyan45.github.io
```

Log out and back in (required on Wayland), then:

```bash
gnome-extensions enable notchline@soefyan45.github.io
```

## Usage

```bash
notchline show "Title" "Body" --icon dialog-information --timeout 5000
notchline dismiss <id>   # id is printed by `show`
notchline config         # print the effective config
notchline reload         # re-read config.toml and apply it
```

System notifications (`notify-send`, apps) are shown in the notch too.
Hover the pill to keep it open; click it to open the app that sent it.
While idle the notch stays hidden; push the pointer to the top center edge
to reveal it (set `reveal_on_hover = false` to keep it always visible).

## Configuration

Open the preferences window with `gnome-extensions prefs notchline@soefyan45.github.io`
(or from the Extensions app). Changes are saved to `~/.config/notchline/config.toml`
right away and applied to the notch; saving rewrites the file, so comments in it are lost.

To edit the file by hand instead, copy [`config.example.toml`](config.example.toml) to
`~/.config/notchline/config.toml`, edit it, then run `notchline reload`. The `[drop]`
and `[spring]` sections tune the liquid drop and the springs behind every movement.

`notchline install-service` also adds a **Notchline** launcher with the app icon to the
app grid and search; it opens the preferences. (The Extensions app has no place for an
extension's own icon.)

## Packaging for extensions.gnome.org

Pack from inside the extension directory (running it from the repo root crashes on
GNOME 46):

```bash
cd extension && gnome-extensions pack . --extra-source=icons --force --out-dir=../dist
```

Upload `dist/notchline@soefyan45.github.io.shell-extension.zip` at
<https://extensions.gnome.org/upload/>; the listing icon is uploaded there separately.
The daemon is not part of the zip, so the listing should point to this repository for
`cargo install`.

## Development

Test the extension without logging out using a nested shell:

```bash
dbus-run-session -- gnome-shell --nested --wayland
```

Then, from a terminal inside that session, run `gnome-extensions enable ...`
and `notchline show ...`.

After changing the daemon, reinstall it and restart the running instance:

```bash
cargo install --path daemon && pkill -f "notchline daemon"
```
