use std::io::Read;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use zbus::export::futures_core::Stream;
use zbus::message::Type as MessageType;
use zbus::object_server::SignalEmitter;
use zbus::{Connection, MatchRule, MessageStream, connection, fdo, interface};

const BUS_NAME: &str = "io.github.soefyan45.Notchline";
const OBJECT_PATH: &str = "/io/github/soefyan45/Notchline";
const INTERFACE: &str = "io.github.soefyan45.Notchline";

#[derive(Parser)]
#[command(name = "notchline", about = "Notch-style notification layer for GNOME")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run the D-Bus service (normally started by D-Bus activation)
    Daemon,
    /// Show a notification in the notch
    Show {
        title: String,
        #[arg(default_value = "")]
        body: String,
        /// Themed icon name, e.g. dialog-information
        #[arg(long, default_value = "")]
        icon: String,
        /// Display time in milliseconds (0 = use config default)
        #[arg(long, default_value_t = 0)]
        timeout: u32,
    },
    /// Show a compact status line in the notch
    Status {
        /// Text after the icon, e.g. Fokus
        #[arg(long, default_value = "")]
        text: String,
        /// Value on the right, e.g. 24.59 or 82%
        #[arg(long, default_value = "")]
        trail: String,
        /// Themed icon name, e.g. alarm-symbolic
        #[arg(long, default_value = "")]
        icon: String,
        /// Color of the icon and value: accent, success, warn, danger or muted
        #[arg(long, default_value = "accent")]
        color: String,
        /// Display time in milliseconds (0 = use config default)
        #[arg(long, default_value_t = 0)]
        timeout: u32,
    },
    /// Start a focus timer in the notch, or stop it
    Focus {
        /// Minutes (default from config), or "stop"
        minutes: Option<String>,
    },
    /// Dismiss a notification or status by id
    Dismiss { id: u32 },
    /// Hide the notch entirely until a new notification arrives, or show it again
    Hide {
        /// "off" shows the notch again
        state: Option<String>,
    },
    /// Forward a coding agent hook event read from stdin (used by the agent's hooks)
    Hook {
        /// Which agent sent it: claude or opencode
        source: String,
    },
    /// Register Notchline with a coding agent: hooks for "claude" (backs up its settings
    /// first), a plugin for "opencode"
    InstallHooks {
        /// claude or opencode
        agent: String,
    },
    /// Remove Notchline's hooks from a coding agent's settings
    UninstallHooks { agent: String },
    /// Reload config.toml and push it to the extension
    Reload,
    /// Print the effective config
    Config,
    /// Install D-Bus activation and the Notchline app launcher
    InstallService,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
struct Config {
    pill: PillConfig,
    behavior: BehaviorConfig,
    drop: DropConfig,
    spring: SpringConfig,
    agent: AgentConfig,
    system: SystemConfig,
}

/// System statuses in the compact notch
#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
struct SystemConfig {
    /// Show the battery level for a few seconds when a charger is plugged in
    charging_notice: bool,
    /// Remind of calendar events shortly before they start
    meeting_reminder: bool,
    meeting_minutes: u32,
    /// Default length of a focus timer
    focus_minutes: u32,
}

impl Default for SystemConfig {
    fn default() -> Self {
        Self { charging_notice: true, meeting_reminder: true, meeting_minutes: 1, focus_minutes: 25 }
    }
}

/// Coding agents (Claude Code hooks) shown in the notch
#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
struct AgentConfig {
    enabled: bool,
    /// Show the agent's todo list as steps, e.g. 4/7
    show_progress: bool,
    /// Bring up the notch when an agent asks for permission
    permission_requests: bool,
    /// Flash the notch when an agent finishes
    notify_done: bool,
    /// Offer "allow once" in the notch, only for safe_commands
    allow_from_notch: bool,
    /// How long a permission request waits in the notch before the terminal asks instead
    permission_timeout_s: u32,
    /// Bash commands that may be allowed from the notch (exact, or followed by arguments)
    safe_commands: Vec<String>,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            show_progress: true,
            permission_requests: true,
            notify_done: true,
            allow_from_notch: true,
            permission_timeout_s: 60,
            safe_commands: ["npm test", "bun run lint", "git status", "git diff", "git log"]
                .map(String::from)
                .to_vec(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
struct PillConfig {
    /// Keep a small notch visible when there is no notification
    idle_visible: bool,
    /// Hide the idle notch until the pointer reaches the top center edge
    reveal_on_hover: bool,
    /// How the notch opens in full: "hover" (resting the pointer on it) or "click"
    open_on: String,
    /// Close the opened notch this long after the pointer leaves it; 0 keeps it open
    /// until a click elsewhere
    auto_close_ms: u64,
    /// "menyatu" grows out of the top edge, "pulau" floats below it
    style: String,
    /// Color theme of the notch, the panel and the preferences: "default" or "te"
    theme: String,
    idle_width: u32,
    idle_height: u32,
    expanded_width: u32,
    expanded_height: u32,
    /// Width of the full panel opened by hovering or pulling the notch
    panel_width: u32,
    top_offset: u32,
    radius: u32,
    background: String,
    opacity: f64,
    animation_ms: u32,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
struct BehaviorConfig {
    timeout_ms: u32,
    /// Suppress GNOME's own notification banners
    hide_gnome_banners: bool,
    /// Show GNOME system notifications in the notch
    capture_system: bool,
    /// Notchline icon in the top bar, with a menu
    show_indicator: bool,
}

/// Liquid drop that reaches for the pointer (logical pixels)
#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
struct DropConfig {
    enabled: bool,
    /// Distance below the notch at which the drop starts reaching for the pointer
    pull_range: f64,
    /// Deepest the drop reaches
    max_depth: f64,
    /// Width range of the drop
    min_width: f64,
    max_width: f64,
    /// How softly the drop blends into the notch
    blend: f64,
}

/// Springs behind every movement, at animation_ms = 280; lower damping wobbles more
#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
struct SpringConfig {
    width_stiffness: f64,
    width_damping: f64,
    height_stiffness: f64,
    height_damping: f64,
    drop_stiffness: f64,
    drop_damping: f64,
    drop_x_stiffness: f64,
    drop_x_damping: f64,
}

impl Default for DropConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            pull_range: 80.0,
            max_depth: 22.0,
            min_width: 5.0,
            max_width: 11.0,
            blend: 6.0,
        }
    }
}

impl Default for SpringConfig {
    fn default() -> Self {
        Self {
            width_stiffness: 170.0,
            width_damping: 15.0,
            height_stiffness: 320.0,
            height_damping: 22.0,
            drop_stiffness: 520.0,
            drop_damping: 20.0,
            drop_x_stiffness: 600.0,
            drop_x_damping: 45.0,
        }
    }
}

impl Default for PillConfig {
    fn default() -> Self {
        Self {
            idle_visible: true,
            reveal_on_hover: true,
            open_on: "hover".into(),
            auto_close_ms: 0,
            style: "menyatu".into(),
            theme: "default".into(),
            idle_width: 200,
            idle_height: 32,
            expanded_width: 420,
            expanded_height: 72,
            panel_width: 840,
            top_offset: 4,
            radius: 20,
            background: "#000000".into(),
            opacity: 0.95,
            animation_ms: 280,
        }
    }
}

impl Default for BehaviorConfig {
    fn default() -> Self {
        Self {
            timeout_ms: 4000,
            hide_gnome_banners: true,
            capture_system: true,
            show_indicator: true,
        }
    }
}

fn config_path() -> PathBuf {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".config"));
    base.join("notchline").join("config.toml")
}

fn save_config(config: &Config) -> Result<(), Box<dyn std::error::Error>> {
    let path = config_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&path, toml::to_string_pretty(config)?)?;
    Ok(())
}

fn load_config() -> Config {
    let path = config_path();
    match std::fs::read_to_string(&path) {
        Ok(text) => toml::from_str(&text).unwrap_or_else(|err| {
            eprintln!("notchline: invalid {}: {err}; using defaults", path.display());
            Config::default()
        }),
        Err(_) => Config::default(),
    }
}

struct Notchline {
    config: Config,
    next_id: u32,
    agents: Vec<AgentSession>,
}

impl Notchline {
    fn next_id(&mut self) -> u32 {
        self.next_id = self.next_id.wrapping_add(1).max(1);
        self.next_id
    }
}

// --- Coding agents --------------------------------------------------------

/// Sessions without any event for this long are dropped
const AGENT_STALE_MS: u64 = 30 * 60 * 1000;
/// Shell patterns that always go to the terminal, even when the command starts like a safe one
const UNSAFE_PATTERNS: [&str; 12] =
    ["\n", ";", "&", "|", "`", "$(", ">", "<", "sudo", "rm -rf", "git push", "curl"];

#[derive(Serialize, Clone)]
struct Todo {
    content: String,
    /// pending, in_progress or completed
    status: String,
}

#[derive(Serialize, Clone)]
struct PendingPermission {
    id: u32,
    /// What it wants to do, e.g. "Bash · bun run migrate"
    tool: String,
    /// Why, from the tool's description when it has one
    detail: String,
    /// May be allowed from the notch
    safe: bool,
}

#[derive(Serialize, Clone, Default)]
struct AgentSession {
    id: String,
    source: String,
    project: String,
    cwd: String,
    /// idle, working, permission or done
    status: String,
    todos: Vec<Todo>,
    /// Current step, e.g. "Bash · npm test"
    tool: String,
    /// First line of the agent's last message when it stopped
    summary: String,
    started_ms: u64,
    finished_ms: Option<u64>,
    updated_ms: u64,
    /// The hook's ancestor processes, to find the agent's terminal window
    pids: Vec<u32>,
    permission: Option<PendingPermission>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn first_line(text: &str, max: usize) -> String {
    let line = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    if line.chars().count() > max {
        format!("{}…", line.chars().take(max).collect::<String>())
    } else {
        line.to_string()
    }
}

/// Short label for a tool call: the command for Bash, the file name for file tools
fn describe_tool(tool: &str, input: &Value) -> String {
    if let Some(command) = input["command"].as_str() {
        return format!("{tool} · {}", first_line(command, 120));
    }
    for key in ["file_path", "notebook_path", "path", "url", "pattern"] {
        if let Some(value) = input[key].as_str() {
            let name = Path::new(value).file_name().and_then(|n| n.to_str()).unwrap_or(value);
            return format!("{tool} · {name}");
        }
    }
    tool.to_string()
}

fn is_safe_command(tool: &str, input: &Value, safe: &[String]) -> bool {
    let Some(command) = input["command"].as_str().filter(|_| tool == "Bash") else {
        return false;
    };
    let command = command.trim();
    if UNSAFE_PATTERNS.iter().any(|p| command.contains(p)) {
        return false;
    }
    safe.iter().any(|entry| command == entry || command.starts_with(&format!("{entry} ")))
}

fn parse_todos(input: &Value) -> Option<Vec<Todo>> {
    let todos = input["todos"].as_array()?;
    Some(
        todos
            .iter()
            .map(|todo| Todo {
                content: todo["content"].as_str().unwrap_or("").to_string(),
                status: todo["status"].as_str().unwrap_or("pending").to_string(),
            })
            .collect(),
    )
}

impl Notchline {
    fn pending_permission_ids(&self) -> Vec<u32> {
        self.agents.iter().filter_map(|s| s.permission.as_ref().map(|p| p.id)).collect()
    }

    /// Fold one hook event into the sessions. Returns a permission id when the event is a
    /// permission request the notch can answer, else 0.
    fn apply_agent_event(&mut self, source: &str, event: &Value) -> u32 {
        let name = event["hook_event_name"].as_str().unwrap_or("");
        let Some(session_id) = event["session_id"].as_str().filter(|id| !id.is_empty()) else {
            return 0;
        };
        let now = now_ms();
        self.agents.retain(|s| now.saturating_sub(s.updated_ms) < AGENT_STALE_MS);
        if name == "SessionEnd" {
            self.agents.retain(|s| s.id != session_id);
            return 0;
        }

        let permission_id = if name == "PermissionRequest" && self.config.agent.permission_requests {
            self.next_id()
        } else {
            0
        };
        let agent = self.config.agent.clone();
        let index = match self.agents.iter().position(|s| s.id == session_id) {
            Some(index) => index,
            None => {
                self.agents.push(AgentSession {
                    id: session_id.to_string(),
                    source: source.to_string(),
                    status: "idle".into(),
                    started_ms: now,
                    ..Default::default()
                });
                self.agents.len() - 1
            }
        };
        let session = &mut self.agents[index];
        session.updated_ms = now;
        if let Some(cwd) = event["cwd"].as_str() {
            session.cwd = cwd.to_string();
            session.project =
                Path::new(cwd).file_name().and_then(|n| n.to_str()).unwrap_or(cwd).to_string();
        }
        if let Some(pids) = event["notchline_pids"].as_array() {
            session.pids = pids.iter().filter_map(|p| p.as_u64()).map(|p| p as u32).collect();
        }

        let tool = event["tool_name"].as_str().unwrap_or("");
        let input = &event["tool_input"];
        match name {
            "SessionStart" => session.status = "idle".into(),
            "UserPromptSubmit" => {
                session.status = "working".into();
                session.started_ms = now;
                session.finished_ms = None;
                session.summary.clear();
                session.tool.clear();
                if session.todos.iter().all(|t| t.status == "completed") {
                    session.todos.clear();
                }
            }
            "PreToolUse" | "PostToolUse" => {
                if tool == "TodoWrite" {
                    if let Some(todos) = parse_todos(input) {
                        session.todos = todos;
                    }
                } else if name == "PreToolUse" {
                    session.tool = describe_tool(tool, input);
                }
                // A tool running means any permission was answered, maybe in the terminal
                session.permission = None;
                session.status = "working".into();
            }
            "TaskCreated" => session.todos.push(Todo {
                content: event["task_subject"].as_str().unwrap_or("").to_string(),
                status: "pending".into(),
            }),
            "TaskCompleted" => {
                let subject = event["task_subject"].as_str().unwrap_or("");
                if let Some(todo) = session.todos.iter_mut().find(|t| t.content == subject) {
                    todo.status = "completed".into();
                }
            }
            "PermissionRequest" if permission_id != 0 => {
                session.status = "permission".into();
                session.permission = Some(PendingPermission {
                    id: permission_id,
                    tool: describe_tool(tool, input),
                    detail: first_line(input["description"].as_str().unwrap_or(""), 120),
                    safe: agent.allow_from_notch && is_safe_command(tool, input, &agent.safe_commands),
                });
            }
            "Notification" if event["notification_type"] == "permission_prompt" => {
                if session.permission.is_none() {
                    session.status = "permission".into();
                }
            }
            "Stop" => {
                session.status = "done".into();
                session.finished_ms = Some(now);
                session.permission = None;
                session.summary = first_line(event["last_assistant_message"].as_str().unwrap_or(""), 140);
            }
            _ => {}
        }
        permission_id
    }
}

#[interface(name = "io.github.soefyan45.Notchline")]
impl Notchline {
    async fn show(
        &mut self,
        title: String,
        body: String,
        icon: String,
        timeout_ms: u32,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<u32> {
        let id = self.next_id();
        let timeout_ms = if timeout_ms == 0 { self.config.behavior.timeout_ms } else { timeout_ms };
        Self::show_requested(&emitter, id, &title, &body, &icon, timeout_ms).await?;
        Ok(id)
    }

    async fn show_status(
        &mut self,
        icon: String,
        text: String,
        trail: String,
        color: String,
        timeout_ms: u32,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<u32> {
        let id = self.next_id();
        let timeout_ms = if timeout_ms == 0 { self.config.behavior.timeout_ms } else { timeout_ms };
        Self::status_requested(&emitter, id, &icon, &text, &trail, &color, timeout_ms).await?;
        Ok(id)
    }

    /// Start a focus timer of `minutes`; 0 stops it
    async fn focus(&self, minutes: u32, #[zbus(signal_emitter)] emitter: SignalEmitter<'_>) -> fdo::Result<()> {
        Self::focus_requested(&emitter, minutes).await?;
        Ok(())
    }

    async fn dismiss(&self, id: u32, #[zbus(signal_emitter)] emitter: SignalEmitter<'_>) -> fdo::Result<()> {
        Self::dismiss_requested(&emitter, id).await?;
        Ok(())
    }

    /// Hide the notch until a new notification arrives; false shows it again
    async fn hide(&self, hidden: bool, #[zbus(signal_emitter)] emitter: SignalEmitter<'_>) -> fdo::Result<()> {
        Self::hide_requested(&emitter, hidden).await?;
        Ok(())
    }

    async fn reload(&mut self, #[zbus(signal_emitter)] emitter: SignalEmitter<'_>) -> fdo::Result<()> {
        self.config = load_config();
        self.config_changed(&emitter).await?;
        Ok(())
    }

    /// Replace the config with a JSON one (from the preferences window) and save it
    async fn set_config(
        &mut self,
        json: String,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        let config: Config =
            serde_json::from_str(&json).map_err(|err| fdo::Error::InvalidArgs(err.to_string()))?;
        save_config(&config).map_err(|err| fdo::Error::Failed(err.to_string()))?;
        self.config = config;
        self.config_changed(&emitter).await?;
        Ok(())
    }

    /// Effective config serialized as JSON, consumed by the extension
    #[zbus(property)]
    fn config(&self) -> String {
        serde_json::to_string(&self.config).unwrap_or_default()
    }

    #[zbus(signal)]
    async fn show_requested(
        emitter: &SignalEmitter<'_>,
        id: u32,
        title: &str,
        body: &str,
        icon: &str,
        timeout_ms: u32,
    ) -> zbus::Result<()>;

    #[zbus(signal)]
    async fn status_requested(
        emitter: &SignalEmitter<'_>,
        id: u32,
        icon: &str,
        text: &str,
        trail: &str,
        color: &str,
        timeout_ms: u32,
    ) -> zbus::Result<()>;

    #[zbus(signal)]
    async fn dismiss_requested(emitter: &SignalEmitter<'_>, id: u32) -> zbus::Result<()>;

    #[zbus(signal)]
    async fn focus_requested(emitter: &SignalEmitter<'_>, minutes: u32) -> zbus::Result<()>;

    #[zbus(signal)]
    async fn hide_requested(emitter: &SignalEmitter<'_>, hidden: bool) -> zbus::Result<()>;

    /// One hook event from a coding agent, as JSON. Returns a permission id when the
    /// notch can answer it (the hook then waits for PermissionAnswered), else 0.
    async fn agent_event(
        &mut self,
        source: String,
        json: String,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<u32> {
        if !self.config.agent.enabled {
            return Ok(0);
        }
        let event: Value =
            serde_json::from_str(&json).map_err(|err| fdo::Error::InvalidArgs(err.to_string()))?;
        let pending = self.pending_permission_ids();
        let id = self.apply_agent_event(&source, &event);
        // Requests cleared by this event were answered elsewhere (the terminal, another
        // request, the session ending): release their waiting hooks right away
        let still_pending = self.pending_permission_ids();
        for cleared in pending.iter().filter(|p| !still_pending.contains(p)) {
            Self::permission_answered(&emitter, *cleared, "terminal").await?;
        }
        self.agents_changed(&emitter).await?;
        Ok(id)
    }

    /// Answer a permission request: "allow", "deny", or "terminal"/"timeout" to let the
    /// terminal ask as usual
    async fn answer_permission(
        &mut self,
        id: u32,
        decision: String,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> fdo::Result<()> {
        for session in &mut self.agents {
            if session.permission.as_ref().is_some_and(|p| p.id == id) {
                session.permission = None;
                session.status = "working".into();
            }
        }
        Self::permission_answered(&emitter, id, &decision).await?;
        self.agents_changed(&emitter).await?;
        Ok(())
    }

    /// Agent sessions serialized as JSON, consumed by the extension
    #[zbus(property)]
    fn agents(&self) -> String {
        serde_json::to_string(&self.agents).unwrap_or_default()
    }

    #[zbus(signal)]
    async fn permission_answered(emitter: &SignalEmitter<'_>, id: u32, decision: &str) -> zbus::Result<()>;
}

async fn run_daemon() -> zbus::Result<()> {
    let service = Notchline { config: load_config(), next_id: 0, agents: Vec::new() };
    // Never take the name from a running daemon or hand it over: a second daemon exits
    // instead of leaving the first one running without the name
    let _conn = connection::Builder::session()
        .allow_name_replacements(false)
        .replace_existing_names(false)
        .name(BUS_NAME)
        .serve_at(OBJECT_PATH, service)
        .build()
        .await?;
    std::future::pending::<()>().await;
    Ok(())
}

async fn call<B>(method: &str, body: &B) -> zbus::Result<zbus::Message>
where
    B: serde::Serialize + zbus::zvariant::DynamicType,
{
    let conn = Connection::session().await?;
    conn.call_method(Some(BUS_NAME), OBJECT_PATH, Some(INTERFACE), method, body).await
}

const EXTENSION_UUID: &str = "notchline@soefyan45.github.io";
const APP_ICON: &str = include_str!("../../extension/icons/notchline-symbol.svg");

fn write_file(path: PathBuf, content: &str) -> std::io::Result<PathBuf> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&path, content)?;
    Ok(path)
}

/// D-Bus activation for this binary, plus a launcher with the Notchline icon that opens
/// the preferences (the Extensions app has no place for an extension's icon)
fn install_service() -> std::io::Result<Vec<PathBuf>> {
    let exe = std::env::current_exe()?;
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".local/share"));

    let service = format!("[D-BUS Service]\nName={BUS_NAME}\nExec={} daemon\n", exe.display());
    let launcher = format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=Notchline\n\
         Comment=Notch-style notifications for GNOME\n\
         Exec=gnome-extensions prefs {EXTENSION_UUID}\n\
         Icon={BUS_NAME}\n\
         Terminal=false\n\
         Categories=GNOME;GTK;Settings;DesktopSettings;\n\
         Keywords=notch;notification;notifikasi;\n"
    );
    Ok(vec![
        write_file(base.join("dbus-1/services").join(format!("{BUS_NAME}.service")), &service)?,
        write_file(base.join("icons/hicolor/scalable/apps").join(format!("{BUS_NAME}.svg")), APP_ICON)?,
        write_file(base.join("applications").join(format!("{BUS_NAME}.desktop")), &launcher)?,
    ])
}

// --- Agent hooks ----------------------------------------------------------

/// Hook events Notchline listens to, and whether Claude Code matches them by tool name
const CLAUDE_HOOK_EVENTS: [(&str, bool); 10] = [
    ("SessionStart", true),
    ("UserPromptSubmit", false),
    ("PreToolUse", true),
    ("PostToolUse", true),
    ("PermissionRequest", true),
    ("Notification", true),
    ("Stop", false),
    ("SessionEnd", true),
    ("TaskCreated", false),
    ("TaskCompleted", false),
];
const HOOK_MARKER: &str = "notchline hook";

/// The hook's parent processes up to init, so the extension can find the terminal window
fn ancestor_pids() -> Vec<u32> {
    let mut pids = Vec::new();
    let mut pid = std::process::id();
    while pid > 1 && pids.len() < 32 {
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
            break;
        };
        // Fields after the parenthesised command name: state, then the parent pid
        let Some(ppid) = stat.rsplit_once(')').and_then(|(_, rest)| rest.split_whitespace().nth(1)) else {
            break;
        };
        pid = ppid.parse().unwrap_or(0);
        pids.push(pid);
    }
    pids
}

async fn next_message(stream: &mut MessageStream) -> Option<zbus::Message> {
    std::future::poll_fn(|cx| Pin::new(&mut *stream).poll_next(cx)).await?.ok()
}

/// Forward one hook event to the daemon. For a permission request the notch can answer,
/// wait for the answer and print Claude Code's decision; on timeout print nothing so the
/// terminal asks as usual.
async fn run_hook(source: &str) -> Result<(), Box<dyn std::error::Error>> {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input)?;
    let mut event: Value = serde_json::from_str(&input)?;
    event["notchline_pids"] = json!(ancestor_pids());

    let conn = Connection::session().await?;
    // Listen before asking, so a quick answer is not missed
    let mut answers = if event["hook_event_name"] == "PermissionRequest" {
        let rule = MatchRule::builder()
            .msg_type(MessageType::Signal)
            .interface(INTERFACE)
            .member("PermissionAnswered")
            .build()?;
        Some(MessageStream::for_match_rule(rule, &conn, None).await?)
    } else {
        None
    };
    let reply = conn
        .call_method(Some(BUS_NAME), OBJECT_PATH, Some(INTERFACE), "AgentEvent", &(source, event.to_string()))
        .await?;
    let id: u32 = reply.body().deserialize()?;
    let Some(answers) = answers.as_mut().filter(|_| id != 0) else {
        return Ok(());
    };

    let wait = async {
        while let Some(message) = next_message(answers).await {
            if let Ok((answered, decision)) = message.body().deserialize::<(u32, String)>() {
                if answered == id {
                    return Some(decision);
                }
            }
        }
        None
    };
    let timeout = Duration::from_secs(load_config().agent.permission_timeout_s.into());
    let decision = match tokio::time::timeout(timeout, wait).await {
        Ok(Some(decision)) => decision,
        _ => {
            // Nobody answered in the notch: clear it there and let the terminal ask
            conn.call_method(Some(BUS_NAME), OBJECT_PATH, Some(INTERFACE), "AnswerPermission", &(id, "timeout"))
                .await?;
            return Ok(());
        }
    };
    let output = match decision.as_str() {
        "allow" => json!({"behavior": "allow"}),
        "deny" => json!({"behavior": "deny", "message": "Denied from Notchline"}),
        _ => return Ok(()),
    };
    println!(
        "{}",
        json!({"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": output}})
    );
    Ok(())
}

const OPENCODE_PLUGIN: &str = include_str!("../../integrations/opencode/notchline.ts");

/// OpenCode loads plugins from plugin/ or plugins/ in its config directory; use whichever
/// already exists
fn opencode_plugin_path() -> PathBuf {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".config"))
        .join("opencode");
    let dir = if base.join("plugin").is_dir() && !base.join("plugins").is_dir() { "plugin" } else { "plugins" };
    base.join(dir).join("notchline.ts")
}

fn edit_opencode_plugin(install: bool) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let path = opencode_plugin_path();
    if install {
        let exe = std::env::current_exe()?;
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(&path, OPENCODE_PLUGIN.replace("__NOTCHLINE__", &exe.display().to_string()))?;
    } else if path.exists() {
        std::fs::remove_file(&path)?;
    }
    Ok(path)
}

fn claude_settings_path() -> PathBuf {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".claude"))
        .join("settings.json")
}

fn is_notchline_entry(entry: &Value) -> bool {
    entry["hooks"]
        .as_array()
        .is_some_and(|hooks| hooks.iter().any(|h| h["command"].as_str().is_some_and(|c| c.contains(HOOK_MARKER))))
}

/// Add (install) or remove Notchline's hooks in Claude Code's settings.json, keeping every
/// other hook and setting. Returns the backup written before changing the file.
fn edit_claude_hooks(install: bool) -> Result<Option<PathBuf>, Box<dyn std::error::Error>> {
    let path = claude_settings_path();
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let mut settings: Value = if text.trim().is_empty() { json!({}) } else { serde_json::from_str(&text)? };
    let backup = if text.is_empty() {
        None
    } else {
        let backup = path.with_extension(format!("json.notchline-backup-{}", now_ms() / 1000));
        std::fs::write(&backup, &text)?;
        Some(backup)
    };

    let exe = std::env::current_exe()?;
    let timeout = load_config().agent.permission_timeout_s + 10;
    if !settings["hooks"].is_object() {
        settings["hooks"] = json!({});
    }
    let hooks = settings["hooks"].as_object_mut().ok_or("hooks is not an object")?;
    for (event, has_matcher) in CLAUDE_HOOK_EVENTS {
        let mut entries: Vec<Value> = hooks
            .get(event)
            .and_then(|e| e.as_array())
            .map(|e| e.iter().filter(|entry| !is_notchline_entry(entry)).cloned().collect())
            .unwrap_or_default();
        if install {
            let command = format!("{} hook claude", exe.display());
            let hook_timeout = if event == "PermissionRequest" { timeout } else { 10 };
            let mut entry = json!({"hooks": [{"type": "command", "command": command, "timeout": hook_timeout}]});
            if has_matcher {
                entry["matcher"] = json!("*");
            }
            entries.push(entry);
        }
        if entries.is_empty() {
            hooks.remove(event);
        } else {
            hooks.insert(event.to_string(), Value::Array(entries));
        }
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&path, serde_json::to_string_pretty(&settings)? + "\n")?;
    Ok(backup)
}

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    if let Command::Hook { source } = &cli.command {
        // A hook must never get in the agent's way: report problems, exit cleanly
        if let Err(err) = run_hook(source).await {
            eprintln!("notchline hook: {err}");
        }
        return;
    }
    let result: Result<(), Box<dyn std::error::Error>> = async {
        match cli.command {
            Command::Daemon => run_daemon().await?,
            Command::Hook { .. } => unreachable!(),
            Command::InstallHooks { agent } | Command::UninstallHooks { agent }
                if agent != "claude" && agent != "opencode" =>
            {
                return Err(format!("unknown agent {agent:?}; use claude or opencode").into());
            }
            Command::InstallHooks { agent } if agent == "opencode" => {
                println!("installed notchline plugin at {}", edit_opencode_plugin(true)?.display());
            }
            Command::UninstallHooks { agent } if agent == "opencode" => {
                println!("removed notchline plugin from {}", edit_opencode_plugin(false)?.display());
            }
            Command::InstallHooks { .. } => {
                let backup = edit_claude_hooks(true)?;
                println!("installed notchline hooks in {}", claude_settings_path().display());
                if let Some(backup) = backup {
                    println!("backup: {}", backup.display());
                }
            }
            Command::UninstallHooks { .. } => {
                let backup = edit_claude_hooks(false)?;
                println!("removed notchline hooks from {}", claude_settings_path().display());
                if let Some(backup) = backup {
                    println!("backup: {}", backup.display());
                }
            }
            Command::Show { title, body, icon, timeout } => {
                let reply = call("Show", &(title, body, icon, timeout)).await?;
                let id: u32 = reply.body().deserialize()?;
                println!("{id}");
            }
            Command::Status { text, trail, icon, color, timeout } => {
                let reply = call("ShowStatus", &(icon, text, trail, color, timeout)).await?;
                let id: u32 = reply.body().deserialize()?;
                println!("{id}");
            }
            Command::Focus { minutes } => {
                let minutes = match minutes.as_deref() {
                    Some("stop") => 0,
                    Some(value) => value.parse().map_err(|_| format!("expected minutes or \"stop\", got {value:?}"))?,
                    None => load_config().system.focus_minutes,
                };
                call("Focus", &(minutes,)).await?;
            }
            Command::Dismiss { id } => {
                call("Dismiss", &(id,)).await?;
            }
            Command::Hide { state } => {
                let hidden = match state.as_deref() {
                    None | Some("on") => true,
                    Some("off") => false,
                    Some(value) => return Err(format!("expected \"on\" or \"off\", got {value:?}").into()),
                };
                call("Hide", &(hidden,)).await?;
            }
            Command::Reload => {
                call("Reload", &()).await?;
            }
            Command::Config => {
                println!("# {}", config_path().display());
                print!("{}", toml::to_string_pretty(&load_config())?);
            }
            Command::InstallService => {
                for path in install_service()? {
                    println!("installed {}", path.display());
                }
            }
        }
        Ok(())
    }
    .await;

    if let Err(err) = result {
        eprintln!("notchline: {err}");
        std::process::exit(1);
    }
}
