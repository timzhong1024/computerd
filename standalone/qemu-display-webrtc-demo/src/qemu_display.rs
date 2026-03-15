#[cfg(feature = "runtime")]
use std::os::fd::{AsFd, AsRawFd, OwnedFd};
#[cfg(feature = "runtime")]
use std::os::unix::net::UnixStream;
#[cfg(feature = "runtime")]
use std::sync::Arc;

#[cfg(feature = "runtime")]
use anyhow::{Context, Result};
#[cfg(feature = "runtime")]
use memmap2::Mmap;
#[cfg(feature = "runtime")]
use tokio::sync::{Mutex, mpsc};
#[cfg(feature = "runtime")]
use tracing::{debug, warn};
#[cfg(feature = "runtime")]
use zbus::connection::Builder;
#[cfg(feature = "runtime")]
use zbus::proxy;
#[cfg(feature = "runtime")]
use zbus::zvariant::Fd;

#[derive(Debug)]
pub enum DisplayEvent {
    FullFrame {
        width: u32,
        height: u32,
        stride: u32,
        format: u32,
        data: Vec<u8>,
    },
    UpdateRect {
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        stride: u32,
        format: u32,
        data: Vec<u8>,
    },
}

#[cfg(feature = "runtime")]
#[proxy(default_service = "org.qemu", interface = "org.qemu.Display1.Console")]
trait ConsoleApi {
    fn register_listener(&self, listener: Fd<'_>) -> zbus::Result<()>;
}

#[cfg(feature = "runtime")]
pub struct QemuDisplaySession {
    _connection: zbus::Connection,
    _listener: zbus::Connection,
}

#[cfg(feature = "runtime")]
impl QemuDisplaySession {
    pub async fn connect(
        address: &str,
        console_id: u32,
        sender: mpsc::UnboundedSender<DisplayEvent>,
    ) -> Result<Self> {
        let connection = connect_to_qemu(address).await?;
        let path = format!("/org/qemu/Display1/Console_{console_id}");
        let proxy = ConsoleApiProxy::builder(&connection)
            .path(path)?
            .build()
            .await?;

        let (control, peer) = UnixStream::pair()?;
        let mapped = Arc::new(Mutex::new(None));

        let listener = Builder::unix_stream(peer)
            .p2p()
            .serve_at(
                "/org/qemu/Display1/Listener",
                Listener {
                    sender: sender.clone(),
                },
            )?
            .serve_at(
                "/org/qemu/Display1/Listener",
                MapListener {
                    sender,
                    mapped: Arc::clone(&mapped),
                },
            )?
            .serve_at("/org/qemu/Display1/Listener", DmabufListener {})?
            .build()
            .await
            .context("failed to build qemu listener connection")?;

        proxy
            .register_listener(control.as_fd().into())
            .await
            .context("failed to register qemu display listener")?;

        Ok(Self {
            _connection: connection,
            _listener: listener,
        })
    }
}

#[cfg(feature = "runtime")]
async fn connect_to_qemu(address: &str) -> Result<zbus::Connection> {
    let builder = if looks_like_dbus_address(address) {
        Builder::address(address)?
    } else {
        let stream = UnixStream::connect(address)
            .with_context(|| format!("failed to connect to unix socket {address}"))?;
        Builder::unix_stream(stream)
    };
    Ok(builder.p2p().build().await?)
}

#[cfg(feature = "runtime")]
fn looks_like_dbus_address(address: &str) -> bool {
    address.contains('=')
}

#[cfg(feature = "runtime")]
struct Listener {
    sender: mpsc::UnboundedSender<DisplayEvent>,
}

#[cfg(feature = "runtime")]
#[zbus::interface(name = "org.qemu.Display1.Listener", spawn = false)]
impl Listener {
    async fn scanout(
        &mut self,
        width: u32,
        height: u32,
        stride: u32,
        format: u32,
        data: serde_bytes::ByteBuf,
    ) {
        let _ = self.sender.send(DisplayEvent::FullFrame {
            width,
            height,
            stride,
            format,
            data: data.into_vec(),
        });
    }

    async fn update(
        &mut self,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        stride: u32,
        format: u32,
        data: serde_bytes::ByteBuf,
    ) {
        let _ = self.sender.send(DisplayEvent::UpdateRect {
            x,
            y,
            w,
            h,
            stride,
            format,
            data: data.into_vec(),
        });
    }

    #[zbus(name = "ScanoutDMABUF")]
    async fn scanout_dmabuf(
        &mut self,
        _fd: Fd<'_>,
        _width: u32,
        _height: u32,
        _stride: u32,
        _fourcc: u32,
        _modifier: u64,
        _y0_top: bool,
    ) -> zbus::fdo::Result<()> {
        Ok(())
    }

    #[zbus(name = "UpdateDMABUF")]
    async fn update_dmabuf(&mut self, _x: i32, _y: i32, _w: i32, _h: i32) -> zbus::fdo::Result<()> {
        Ok(())
    }

    async fn disable(&mut self) {}

    async fn mouse_set(&mut self, _x: i32, _y: i32, _on: i32) {}

    async fn cursor_define(
        &mut self,
        _width: i32,
        _height: i32,
        _hot_x: i32,
        _hot_y: i32,
        _data: Vec<u8>,
    ) {
    }

    #[zbus(property)]
    fn interfaces(&self) -> Vec<String> {
        vec![
            "org.qemu.Display1.Listener".to_string(),
            "org.qemu.Display1.Listener.Unix.Map".to_string(),
            "org.qemu.Display1.Listener.Unix.ScanoutDMABUF2".to_string(),
        ]
    }
}

#[cfg(feature = "runtime")]
struct ScanoutMap {
    fd: OwnedFd,
    offset: u32,
    width: u32,
    height: u32,
    stride: u32,
    format: u32,
}

#[cfg(feature = "runtime")]
struct ScanoutMmap {
    width: u32,
    height: u32,
    stride: u32,
    format: u32,
    mmap: Mmap,
}

#[cfg(feature = "runtime")]
impl ScanoutMap {
    fn mmap(self) -> std::io::Result<ScanoutMmap> {
        let len = self.height as usize * self.stride as usize;
        let offset = self.offset;
        let desc = self.fd.as_raw_fd();
        let mmap = unsafe {
            memmap2::MmapOptions::new()
                .len(len)
                .offset(offset.into())
                .map(desc)?
        };
        Ok(ScanoutMmap {
            width: self.width,
            height: self.height,
            stride: self.stride,
            format: self.format,
            mmap,
        })
    }
}

#[cfg(feature = "runtime")]
impl AsRef<[u8]> for ScanoutMmap {
    fn as_ref(&self) -> &[u8] {
        self.mmap.as_ref()
    }
}

#[cfg(feature = "runtime")]
struct MapListener {
    sender: mpsc::UnboundedSender<DisplayEvent>,
    mapped: Arc<Mutex<Option<ScanoutMmap>>>,
}

#[cfg(feature = "runtime")]
#[zbus::interface(name = "org.qemu.Display1.Listener.Unix.Map", spawn = false)]
impl MapListener {
    async fn scanout_map(
        &mut self,
        fd: Fd<'_>,
        offset: u32,
        width: u32,
        height: u32,
        stride: u32,
        format: u32,
    ) -> zbus::fdo::Result<()> {
        let scanout = ScanoutMap {
            fd: fd.as_fd().try_clone_to_owned().unwrap(),
            offset,
            width,
            height,
            stride,
            format,
        };
        let mmap = scanout
            .mmap()
            .map_err(|error| zbus::fdo::Error::Failed(error.to_string()))?;
        let bytes = mmap.as_ref().to_vec();
        *self.mapped.lock().await = Some(mmap);
        let _ = self.sender.send(DisplayEvent::FullFrame {
            width,
            height,
            stride,
            format,
            data: bytes,
        });
        Ok(())
    }

    async fn update_map(&mut self, x: i32, y: i32, w: i32, h: i32) -> zbus::fdo::Result<()> {
        let guard = self.mapped.lock().await;
        let Some(mapped) = guard.as_ref() else {
            return Ok(());
        };
        if x < 0 || y < 0 || w <= 0 || h <= 0 {
            return Ok(());
        }

        let row_len = w as usize * 4;
        let mut rect = Vec::with_capacity(row_len * h as usize);
        for row in 0..h as usize {
            let start = (y as usize + row) * mapped.stride as usize + x as usize * 4;
            let end = start + row_len;
            if end > mapped.as_ref().len() {
                warn!("ignoring qemu update outside mapped framebuffer");
                return Ok(());
            }
            rect.extend_from_slice(&mapped.as_ref()[start..end]);
        }

        let _ = self.sender.send(DisplayEvent::UpdateRect {
            x,
            y,
            w,
            h,
            stride: w as u32 * 4,
            format: mapped.format,
            data: rect,
        });
        Ok(())
    }
}

#[cfg(feature = "runtime")]
struct DmabufListener {}

#[cfg(feature = "runtime")]
#[zbus::interface(name = "org.qemu.Display1.Listener.Unix.ScanoutDMABUF2", spawn = false)]
impl DmabufListener {
    #[zbus(name = "ScanoutDMABUF2")]
    async fn scanout_dmabuf(
        &mut self,
        fd: Vec<Fd<'_>>,
        _x: u32,
        _y: u32,
        width: u32,
        height: u32,
        _offset: Vec<u32>,
        _stride: Vec<u32>,
        num_planes: u32,
        fourcc: u32,
        _backing_width: u32,
        _backing_height: u32,
        modifier: u64,
        y0_top: bool,
    ) -> zbus::fdo::Result<()> {
        debug!(
            fd_count = fd.len(),
            width, height, num_planes, fourcc, modifier, y0_top, "detected qemu dmabuf scanout"
        );
        Ok(())
    }
}
