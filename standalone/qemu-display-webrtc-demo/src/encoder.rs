use std::process::Stdio;

use anyhow::{Context, Result};
use tokio::io::AsyncWriteExt;
use tokio::process::{Child, ChildStdin, Command};

use crate::framebuffer::PixelFormat;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncoderConfig {
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub pixel_format: PixelFormat,
    pub rtp_port: u16,
}

pub struct FfmpegEncoder {
    config: EncoderConfig,
    child: Child,
    stdin: ChildStdin,
}

impl FfmpegEncoder {
    pub async fn spawn(config: EncoderConfig) -> Result<Self> {
        let mut command = build_ffmpeg_command(&config);
        let mut child = command.spawn().context("failed to spawn ffmpeg")?;
        let stdin = child.stdin.take().context("ffmpeg stdin unavailable")?;
        Ok(Self {
            config,
            child,
            stdin,
        })
    }

    pub fn config(&self) -> &EncoderConfig {
        &self.config
    }

    pub async fn send_frame(&mut self, data: &[u8]) -> Result<()> {
        self.stdin
            .write_all(data)
            .await
            .context("failed to write frame to ffmpeg")
    }

    pub async fn shutdown(mut self) -> Result<()> {
        self.stdin.shutdown().await.ok();
        let status = self
            .child
            .wait()
            .await
            .context("failed to wait for ffmpeg")?;
        if !status.success() {
            anyhow::bail!("ffmpeg exited with status {status}");
        }
        Ok(())
    }
}

pub fn build_ffmpeg_command(config: &EncoderConfig) -> Command {
    let mut command = Command::new("ffmpeg");
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .arg("-hide_banner")
        .arg("-loglevel")
        .arg("warning")
        .arg("-f")
        .arg("rawvideo")
        .arg("-pixel_format")
        .arg(config.pixel_format.ffmpeg_rawvideo_name())
        .arg("-video_size")
        .arg(format!("{}x{}", config.width, config.height))
        .arg("-framerate")
        .arg(config.fps.to_string())
        .arg("-i")
        .arg("pipe:0")
        .arg("-an")
        .arg("-c:v")
        .arg("libx264")
        .arg("-preset")
        .arg("ultrafast")
        .arg("-tune")
        .arg("zerolatency")
        .arg("-pix_fmt")
        .arg("yuv420p")
        .arg("-bf")
        .arg("0")
        .arg("-g")
        .arg("30")
        .arg("-keyint_min")
        .arg("30")
        .arg("-f")
        .arg("rtp")
        .arg("-payload_type")
        .arg("96")
        .arg(format!("rtp://127.0.0.1:{}?pkt_size=1200", config.rtp_port));
    command
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_expected_low_latency_ffmpeg_command() {
        let config = EncoderConfig {
            width: 1280,
            height: 720,
            fps: 30,
            pixel_format: PixelFormat::Bgr0,
            rtp_port: 5004,
        };
        let command = build_ffmpeg_command(&config);
        let args = command
            .as_std()
            .get_args()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect::<Vec<_>>();

        assert!(args.contains(&"libx264".to_string()));
        assert!(args.contains(&"ultrafast".to_string()));
        assert!(args.contains(&"zerolatency".to_string()));
        assert!(args.contains(&"bgr0".to_string()));
        assert!(args.contains(&"rtp://127.0.0.1:5004?pkt_size=1200".to_string()));
    }
}
