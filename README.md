<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-on-dark.png">
    <img src="assets/logo-on-light.png" width="291" alt="Notchline">
  </picture>
</p>

<p align="center">
  A notch-style notification layer for GNOME, written in Rust.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/GNOME_Shell-46-4A86CF?logo=gnome&logoColor=white" alt="GNOME Shell 46">
  <img src="https://img.shields.io/badge/Rust-2024-000000?logo=rust" alt="Rust 2024">
  <img src="https://img.shields.io/badge/license-GPL--2.0--or--later-2DD4BF" alt="License: GPL-2.0-or-later">
</p>

Notifications appear as a pill at the top center of the screen that expands
when something arrives and shrinks back to a small notch afterwards.

## Features

- **Notifications in the notch:** `notify-send` and app notifications, plus `notchline show` from the CLI.
- **Full panel:** pull the notch down for music controls, the calendar and coding agent sessions.
- **System statuses:** battery level on charging, upcoming meetings and a focus timer.
- **Coding agents:** live progress of Claude Code and OpenCode, with permission requests you can answer from the notch.
- **Themes:** the default black with a teal accent, or TE with graphite cards and an orange accent.
- **Hide on demand:** hide the notch entirely until something new arrives.
- **Liquid motion:** a drip animation and springs behind every movement, tunable in the config.
- **Preferences window:** every setting in the GNOME Extensions app, saved to `~/.config/notchline/config.toml`.

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
- x86_64 Linux for the release build, or a Rust toolchain (`cargo`) to build from source

## Install

### From a release

Download the daemon and the extension from the
[latest release](https://github.com/soefyan45/notchline/releases/latest):

```bash
VERSION=v0.1.0
BASE=https://github.com/soefyan45/notchline/releases/download/$VERSION

# 1. Daemon + CLI
curl -LO "$BASE/notchline-$VERSION-x86_64-linux.tar.gz"
tar xzf "notchline-$VERSION-x86_64-linux.tar.gz"
install -Dm755 "notchline-$VERSION-x86_64-linux/notchline" ~/.local/bin/notchline
~/.local/bin/notchline install-service   # D-Bus activation: the daemon starts on demand

# 2. Extension
curl -LO "$BASE/notchline@soefyan45.github.io.shell-extension.zip"
gnome-extensions install --force notchline@soefyan45.github.io.shell-extension.zip
```

Put the binary where it will stay before running `install-service` (and `install-hooks`):
both write its full path. To update, replace the file at the same path and run
`pkill -f '^.*/notchline daemon$'`; the next call starts the new daemon. Each release
also has a `SHA256SUMS` file to check the downloads with `sha256sum -c SHA256SUMS`.

### From source

```bash
# 1. Daemon + CLI
cargo install --path daemon
notchline install-service   # D-Bus activation: the daemon starts on demand

# 2. Extension
mkdir -p ~/.local/share/gnome-shell/extensions
ln -sfn "$PWD/extension" ~/.local/share/gnome-shell/extensions/notchline@soefyan45.github.io
```

### Enable

Log out and back in (required on Wayland), then:

```bash
gnome-extensions enable notchline@soefyan45.github.io
```

## Usage

```bash
notchline show "Title" "Body" --icon dialog-information --timeout 5000
notchline dismiss <id>   # id is printed by `show`
notchline hide           # hide the notch until something new arrives
notchline hide off       # show it again
notchline config         # print the effective config
notchline reload         # re-read config.toml and apply it
```

System notifications (`notify-send`, apps) are shown in the notch too.
Hover the pill to keep it open; click it to open the app that sent it.
While idle the notch stays hidden; push the pointer to the top center edge
to reveal it (set `reveal_on_hover = false` to keep it always visible).

To get the notch out of the way, pick **Sembunyikan notch** in the top bar menu or run
`notchline hide`. It stays hidden, even while idle or with music playing, until a new
notification or status arrives (a charger, a meeting, an agent asking for permission),
then shows again as usual. Hiding drops what is already shown or queued, and it resets
on the next login.

## System statuses

Without anything to ask, the notch also shows on its own:

- **Charging:** the battery level for 3 seconds when a charger is plugged in (UPower).
- **Meeting soon:** a calendar event from GNOME Calendar, `meeting_minutes` before it starts.
- **Focus timer:** the time left, from the top bar menu or `notchline focus [minutes|stop]`.

When several things run at once, the compact notch shows a permission request first, then
the focus timer, a working agent, and playing music; notifications interrupt briefly.

## Coding agents

Notchline shows what Claude Code and OpenCode are doing: the current step and todo progress
(`Claude Code 4/7`), permission requests, and a short notice when it finishes. Hover or
pull the notch and open the **Agen** tab for the full session cards.

```bash
notchline install-hooks claude     # adds hooks to ~/.claude/settings.json (backs it up first)
notchline uninstall-hooks claude   # removes only Notchline's hooks
notchline install-hooks opencode   # writes ~/.config/opencode/plugins/notchline.ts
notchline uninstall-hooks opencode
```

The same can be done from Preferences → Agen AI. Each hook runs `notchline hook claude`,
which forwards the event to the daemon and returns at once; it never blocks the agent if
the daemon is unavailable. The OpenCode plugin
([`integrations/opencode/notchline.ts`](integrations/opencode/notchline.ts)) turns
OpenCode's events into the same shape and calls `notchline hook opencode`.

When an agent asks for permission, the notch opens on the agents tab. **Tolak** denies,
**Di terminal** hands the question back to the terminal, and **Izinkan sekali** appears only
for commands in `[agent] safe_commands` (anything with `;`, `&`, `|`, `` ` ``, `$(`, `>`,
`<`, `sudo`, `rm -rf`, `git push` or `curl` always goes to the terminal). Without an answer
within `permission_timeout_s`, the terminal asks as usual.

## Configuration

Open the preferences window with `gnome-extensions prefs notchline@soefyan45.github.io`
(or from the Extensions app). Changes are saved to `~/.config/notchline/config.toml`
right away and applied to the notch; saving rewrites the file, so comments in it are lost.

The `theme` key in `[pill]` picks the colors of the notch, the panel and the accent of the
preferences window: `"default"` (black, teal accent) or `"te"` (graphite, orange accent).
Picking a theme in the preferences also sets the notch color to match it.

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
The daemon is not part of the zip, so the listing should point to this repository's
releases for it. Pushing a `v*` tag builds both the daemon and this zip and attaches them
to a GitHub release (`.github/workflows/release.yml`).

## Development

Test the extension without logging out using a nested shell:

```bash
dbus-run-session -- gnome-shell --nested --wayland
```

Then, from a terminal inside that session, run `gnome-extensions enable ...`
and `notchline show ...`.

After changing the daemon, reinstall it and restart the running instance:

```bash
cargo install --path daemon && pkill -f '^.*/notchline daemon$'
```

## License

Notchline is free software, released under the
[GNU General Public License v2.0 or later](LICENSE).
