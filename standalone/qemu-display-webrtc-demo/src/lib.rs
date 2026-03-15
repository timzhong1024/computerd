pub mod encoder;
pub mod framebuffer;
pub mod health;
pub mod webrtc;

#[cfg(feature = "runtime")]
pub mod qemu_display;

pub const INDEX_HTML: &str = include_str!("../static/index.html");
