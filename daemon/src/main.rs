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
    /// Dismiss a notification by id
    Dismiss { id: u32 },
    /// Reload config.toml and push it to the extension
    Reload,
    /// Print the effective config
    Config,
    /// Install the D-Bus activation file for this binary
    InstallService,
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(default)]
struct Config {
    pill: PillConfig,
    behavior: BehaviorConfig,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
struct PillConfig {
    /// Keep a small notch visible when there is no notification
    idle_visible: bool,
    /// Hide the idle notch until the pointer reaches the top center edge
    reveal_on_hover: bool,
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

impl Default for PillConfig {
    fn default() -> Self {
        Self {
            idle_visible: true,
            reveal_on_hover: true,
            idle_width: 160,
            idle_height: 30,
            expanded_width: 420,
            expanded_height: 72,
            top_offset: 4,
            radius: 18,
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
        self.next_id = self.next_id.wrapping_add(1).max(1);
        let id = self.next_id;
        let timeout_ms = if timeout_ms == 0 { self.config.behavior.timeout_ms } else { timeout_ms };
        Self::show_requested(&emitter, id, &title, &body, &icon, timeout_ms).await?;
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

fn install_service() -> std::io::Result<PathBuf> {
    let exe = std::env::current_exe()?;
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".local/share"));
    let dir = base.join("dbus-1/services");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{BUS_NAME}.service"));
    let content = format!("[D-BUS Service]\nName={BUS_NAME}\nExec={} daemon\n", exe.display());
    std::fs::write(&path, content)?;
    Ok(path)
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
                println!("installed {}", install_service()?.display());
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
