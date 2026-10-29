use std::path::PathBuf;

use clap::{Parser, Subcommand};
use serde::{Deserialize, Serialize};
use zbus::object_server::SignalEmitter;
use zbus::{Connection, connection, fdo, interface};

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
    /// Dismiss a notification or status by id
    Dismiss { id: u32 },
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
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
struct PillConfig {
    /// Keep a small notch visible when there is no notification
    idle_visible: bool,
    /// Hide the idle notch until the pointer reaches the top center edge
    reveal_on_hover: bool,
    /// "menyatu" grows out of the top edge, "pulau" floats below it
    style: String,
    idle_width: u32,
    idle_height: u32,
    expanded_width: u32,
    expanded_height: u32,
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
            style: "menyatu".into(),
            idle_width: 200,
            idle_height: 32,
            expanded_width: 420,
            expanded_height: 72,
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
}

impl Notchline {
    fn next_id(&mut self) -> u32 {
        self.next_id = self.next_id.wrapping_add(1).max(1);
        self.next_id
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

    async fn dismiss(&self, id: u32, #[zbus(signal_emitter)] emitter: SignalEmitter<'_>) -> fdo::Result<()> {
        Self::dismiss_requested(&emitter, id).await?;
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
}

async fn run_daemon() -> zbus::Result<()> {
    let service = Notchline { config: load_config(), next_id: 0 };
    let _conn = connection::Builder::session()
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

#[tokio::main]
async fn main() {
    let cli = Cli::parse();
    let result: Result<(), Box<dyn std::error::Error>> = async {
        match cli.command {
            Command::Daemon => run_daemon().await?,
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
            Command::Dismiss { id } => {
                call("Dismiss", &(id,)).await?;
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
