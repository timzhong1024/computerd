#[cfg(not(feature = "runtime"))]
fn main() {
    eprintln!(
        "qemu-display-webrtc-demo was built without runtime support.\n\
     Rebuild with: cargo run --features runtime -- <args>"
    );
    std::process::exit(1);
}

#[cfg(feature = "runtime")]
use std::net::SocketAddr;
#[cfg(feature = "runtime")]
use std::sync::Arc;
#[cfg(feature = "runtime")]
use std::time::Duration;

#[cfg(feature = "runtime")]
use anyhow::{Context, Result};
#[cfg(feature = "runtime")]
use axum::extract::State;
#[cfg(feature = "runtime")]
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
#[cfg(feature = "runtime")]
use axum::response::{Html, IntoResponse};
#[cfg(feature = "runtime")]
use axum::routing::get;
#[cfg(feature = "runtime")]
use axum::{Json, Router};
#[cfg(feature = "runtime")]
use clap::Parser;
#[cfg(feature = "runtime")]
use futures_util::{SinkExt, StreamExt};
#[cfg(feature = "runtime")]
use qemu_display_webrtc_demo::encoder::{EncoderConfig, FfmpegEncoder};
#[cfg(feature = "runtime")]
use qemu_display_webrtc_demo::framebuffer::Framebuffer;
#[cfg(feature = "runtime")]
use qemu_display_webrtc_demo::health::HealthState;
#[cfg(feature = "runtime")]
use qemu_display_webrtc_demo::qemu_display::{DisplayEvent, QemuDisplaySession};
#[cfg(feature = "runtime")]
use qemu_display_webrtc_demo::webrtc::{SignalMessage, SingleViewerGate, WebRtcSession};
#[cfg(feature = "runtime")]
use tokio::net::TcpListener;
#[cfg(feature = "runtime")]
use tokio::sync::{Mutex, mpsc};
#[cfg(feature = "runtime")]
use tracing::{error, info, warn};

#[cfg(feature = "runtime")]
#[derive(Debug, Parser, Clone)]
#[command(name = "qemu-display-webrtc-demo")]
struct Cli {
    #[arg(long)]
    qemu_dbus_address: String,
    #[arg(long, default_value_t = 0)]
    console_id: u32,
    #[arg(long, default_value = "127.0.0.1:8080")]
    listen: SocketAddr,
    #[arg(long, default_value_t = 5004)]
    rtp_port: u16,
    #[arg(long, default_value_t = 30)]
    fps: u32,
}

#[cfg(feature = "runtime")]
#[derive(Clone)]
struct AppState {
    health: Arc<HealthState>,
    viewers: Arc<SingleViewerGate>,
    rtp_port: u16,
}

#[cfg(feature = "runtime")]
#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "qemu_display_webrtc_demo=debug,info".into()),
        )
        .init();

    let cli = Cli::parse();
    let health = Arc::new(HealthState::default());
    let framebuffer = Arc::new(Mutex::new(Framebuffer::default()));
    let (display_tx, mut display_rx) = mpsc::unbounded_channel();

    let _display_session =
        QemuDisplaySession::connect(&cli.qemu_dbus_address, cli.console_id, display_tx)
            .await
            .context("failed to connect to qemu display")?;
    health.set_qemu_connected(true);

    let ingest_framebuffer = Arc::clone(&framebuffer);
    let ingest_health = Arc::clone(&health);
    tokio::spawn(async move {
        while let Some(event) = display_rx.recv().await {
            let mut framebuffer = ingest_framebuffer.lock().await;
            let result = match event {
                DisplayEvent::FullFrame {
                    width,
                    height,
                    stride,
                    format,
                    data,
                } => framebuffer.apply_scanout(width, height, stride, format, data),
                DisplayEvent::UpdateRect {
                    x,
                    y,
                    w,
                    h,
                    stride,
                    format,
                    data,
                } => framebuffer.apply_update(x, y, w, h, stride, format, data),
            };
            if let Err(error) = result {
                warn!("failed to apply qemu display event: {error}");
                ingest_health.set_last_error(error.to_string()).await;
            }
        }
    });

    let encode_framebuffer = Arc::clone(&framebuffer);
    let encode_health = Arc::clone(&health);
    let fps = cli.fps;
    let rtp_port = cli.rtp_port;
    tokio::spawn(async move {
        if let Err(error) = run_encoder_loop(encode_framebuffer, encode_health, fps, rtp_port).await
        {
            error!("encoder loop failed: {error:?}");
        }
    });

    let state = AppState {
        health,
        viewers: Arc::new(SingleViewerGate::default()),
        rtp_port: cli.rtp_port,
    };

    let app = Router::new()
        .route("/", get(index))
        .route("/healthz", get(healthz))
        .route("/ws", get(ws))
        .with_state(state);

    let listener = TcpListener::bind(cli.listen).await?;
    info!("listening on http://{}", cli.listen);
    axum::serve(listener, app).await?;
    Ok(())
}

#[cfg(feature = "runtime")]
async fn run_encoder_loop(
    framebuffer: Arc<Mutex<Framebuffer>>,
    health: Arc<HealthState>,
    fps: u32,
    rtp_port: u16,
) -> Result<()> {
    let mut interval = tokio::time::interval(Duration::from_millis(u64::from(1000 / fps.max(1))));
    let mut encoder: Option<FfmpegEncoder> = None;

    loop {
        interval.tick().await;
        let snapshot = {
            let mut framebuffer = framebuffer.lock().await;
            framebuffer.take_snapshot_if_dirty()
        };

        let Some(snapshot) = snapshot else {
            continue;
        };

        let desired = EncoderConfig {
            width: snapshot.width,
            height: snapshot.height,
            fps,
            pixel_format: snapshot.format,
            rtp_port,
        };

        let must_restart = encoder
            .as_ref()
            .map(|encoder| encoder.config() != &desired)
            .unwrap_or(true);

        if must_restart {
            if let Some(existing) = encoder.take() {
                let _ = existing.shutdown().await;
            }
            encoder = Some(FfmpegEncoder::spawn(desired).await?);
            health.set_ffmpeg_running(true);
            health.clear_last_error().await;
        }

        if let Some(encoder) = encoder.as_mut() {
            encoder.send_frame(&snapshot.packed_bytes()).await?;
            health.set_last_frame_generation(snapshot.generation);
        }
    }
}

#[cfg(feature = "runtime")]
async fn index() -> Html<&'static str> {
    Html(qemu_display_webrtc_demo::INDEX_HTML)
}

#[cfg(feature = "runtime")]
async fn healthz(
    State(state): State<AppState>,
) -> Json<qemu_display_webrtc_demo::health::HealthSnapshot> {
    Json(state.health.snapshot().await)
}

#[cfg(feature = "runtime")]
async fn ws(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws(socket, state))
}

#[cfg(feature = "runtime")]
async fn handle_ws(mut socket: WebSocket, state: AppState) {
    let Some(_lease) = state.viewers.try_acquire() else {
        let _ = socket
            .send(Message::Close(Some(axum::extract::ws::CloseFrame {
                code: axum::extract::ws::close_code::POLICY,
                reason: "single viewer already connected".into(),
            })))
            .await;
        return;
    };

    let (signal_tx, mut signal_rx) = mpsc::unbounded_channel();
    let session = match WebRtcSession::new(state.rtp_port, signal_tx) {
        Ok(session) => session,
        Err(error) => {
            warn!("failed to create webrtc session: {error:?}");
            let _ = socket.send(Message::Close(None)).await;
            return;
        }
    };

    loop {
        tokio::select! {
          Some(server_message) = signal_rx.recv() => {
            match serde_json::to_string(&server_message) {
              Ok(payload) => {
                if socket.send(Message::Text(payload.into())).await.is_err() {
                  break;
                }
              }
              Err(error) => {
                warn!("failed to serialize signaling message: {error}");
                break;
              }
            }
          }
          inbound = socket.next() => {
            match inbound {
              Some(Ok(Message::Text(text))) => {
                match serde_json::from_str::<SignalMessage>(&text) {
                  Ok(SignalMessage::Answer { sdp }) => {
                    if let Err(error) = session.apply_remote_answer(&sdp) {
                      warn!("failed to apply remote answer: {error:?}");
                      break;
                    }
                  }
                  Ok(SignalMessage::Ice { candidate }) => {
                    session.add_ice_candidate(&candidate);
                  }
                  Ok(SignalMessage::Offer { .. }) => {
                    warn!("browser sent unexpected offer");
                  }
                  Err(error) => {
                    warn!("failed to parse signaling payload: {error}");
                    break;
                  }
                }
              }
              Some(Ok(Message::Close(_))) | None => break,
              Some(Ok(_)) => {}
              Some(Err(error)) => {
                warn!("websocket error: {error}");
                break;
              }
            }
          }
        }
    }
}
