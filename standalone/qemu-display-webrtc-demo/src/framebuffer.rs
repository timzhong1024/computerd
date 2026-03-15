use anyhow::{Result, anyhow, bail, ensure};

const PIXMAN_TYPE_ARGB: u32 = 2;
const PIXMAN_TYPE_ABGR: u32 = 3;

const fn pixman_format(bpp: u32, type_: u32, a: u32, r: u32, g: u32, b: u32) -> u32 {
    (bpp << 24) | (type_ << 16) | (a << 12) | (r << 8) | (g << 4) | b
}

pub const PIXMAN_X8R8G8B8: u32 = pixman_format(32, PIXMAN_TYPE_ARGB, 0, 8, 8, 8);
pub const PIXMAN_A8R8G8B8: u32 = pixman_format(32, PIXMAN_TYPE_ARGB, 8, 8, 8, 8);
pub const PIXMAN_X8B8G8R8: u32 = pixman_format(32, PIXMAN_TYPE_ABGR, 0, 8, 8, 8);
pub const PIXMAN_A8B8G8R8: u32 = pixman_format(32, PIXMAN_TYPE_ABGR, 8, 8, 8, 8);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PixelFormat {
    Bgr0,
    Bgra,
    Rgb0,
    Rgba,
}

impl PixelFormat {
    pub fn from_pixman(format: u32) -> Result<Self> {
        match format {
            PIXMAN_X8R8G8B8 => Ok(Self::Bgr0),
            PIXMAN_A8R8G8B8 => Ok(Self::Bgra),
            PIXMAN_X8B8G8R8 => Ok(Self::Rgb0),
            PIXMAN_A8B8G8R8 => Ok(Self::Rgba),
            _ => Err(anyhow!("unsupported pixman format {format:#x}")),
        }
    }

    pub fn ffmpeg_rawvideo_name(self) -> &'static str {
        match self {
            Self::Bgr0 => "bgr0",
            Self::Bgra => "bgra",
            Self::Rgb0 => "rgb0",
            Self::Rgba => "rgba",
        }
    }

    pub const fn bytes_per_pixel(self) -> usize {
        4
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrameSnapshot {
    pub width: u32,
    pub height: u32,
    pub stride: u32,
    pub format: PixelFormat,
    pub generation: u64,
    pub data: Vec<u8>,
}

impl FrameSnapshot {
    pub fn packed_bytes(&self) -> Vec<u8> {
        let row_len = self.width as usize * self.format.bytes_per_pixel();
        if self.stride as usize == row_len {
            return self.data.clone();
        }

        let mut packed = Vec::with_capacity(row_len * self.height as usize);
        for row in 0..self.height as usize {
            let start = row * self.stride as usize;
            packed.extend_from_slice(&self.data[start..start + row_len]);
        }
        packed
    }
}

#[derive(Debug, Default)]
pub struct Framebuffer {
    width: u32,
    height: u32,
    stride: u32,
    format: Option<PixelFormat>,
    data: Vec<u8>,
    dirty: bool,
    generation: u64,
}

impl Framebuffer {
    pub fn has_configuration(&self) -> bool {
        self.format.is_some()
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn apply_scanout(
        &mut self,
        width: u32,
        height: u32,
        stride: u32,
        format: u32,
        data: Vec<u8>,
    ) -> Result<()> {
        let format = PixelFormat::from_pixman(format)?;
        validate_buffer(height, stride, &data)?;
        self.width = width;
        self.height = height;
        self.stride = stride;
        self.format = Some(format);
        self.data = data;
        self.dirty = true;
        self.generation += 1;
        Ok(())
    }

    pub fn apply_update(
        &mut self,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        stride: u32,
        format: u32,
        data: Vec<u8>,
    ) -> Result<()> {
        let pixel_format = PixelFormat::from_pixman(format)?;
        let current_format = self
            .format
            .ok_or_else(|| anyhow!("update received before initial scanout"))?;
        ensure!(
            pixel_format == current_format,
            "update format changed from {:?} to {:?}",
            current_format,
            pixel_format
        );
        ensure!(x >= 0 && y >= 0 && w > 0 && h > 0, "invalid update rect");
        let (x, y, w, h) = (x as u32, y as u32, w as u32, h as u32);
        ensure!(x + w <= self.width, "update rect exceeds framebuffer width");
        ensure!(
            y + h <= self.height,
            "update rect exceeds framebuffer height"
        );
        validate_buffer(h, stride, &data)?;

        let row_len = w as usize * current_format.bytes_per_pixel();
        ensure!(
            stride as usize >= row_len,
            "update stride {stride} too small for width {w}"
        );

        for row in 0..h as usize {
            let src_start = row * stride as usize;
            let dst_start = (y as usize + row) * self.stride as usize
                + x as usize * current_format.bytes_per_pixel();
            self.data[dst_start..dst_start + row_len]
                .copy_from_slice(&data[src_start..src_start + row_len]);
        }

        self.dirty = true;
        self.generation += 1;
        Ok(())
    }

    pub fn take_snapshot_if_dirty(&mut self) -> Option<FrameSnapshot> {
        if !self.dirty {
            return None;
        }
        let format = self.format?;
        self.dirty = false;
        Some(FrameSnapshot {
            width: self.width,
            height: self.height,
            stride: self.stride,
            format,
            generation: self.generation,
            data: self.data.clone(),
        })
    }
}

fn validate_buffer(height: u32, stride: u32, data: &[u8]) -> Result<()> {
    let expected = height as usize * stride as usize;
    if data.len() < expected {
        bail!(
            "buffer too short: got {}, expected at least {expected}",
            data.len()
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pixel(x: u8) -> [u8; 4] {
        [x, x.wrapping_add(1), x.wrapping_add(2), x.wrapping_add(3)]
    }

    #[test]
    fn maps_supported_pixman_formats() {
        assert_eq!(
            PixelFormat::from_pixman(PIXMAN_X8R8G8B8).unwrap(),
            PixelFormat::Bgr0
        );
        assert_eq!(
            PixelFormat::from_pixman(PIXMAN_A8R8G8B8).unwrap(),
            PixelFormat::Bgra
        );
    }

    #[test]
    fn rejects_unknown_pixman_format() {
        assert!(PixelFormat::from_pixman(0xdeadbeef).is_err());
    }

    #[test]
    fn applies_incremental_updates_to_backing_buffer() {
        let mut framebuffer = Framebuffer::default();
        let initial = vec![
            0, 1, 2, 3, 10, 11, 12, 13, 20, 21, 22, 23, 30, 31, 32, 33, 40, 41, 42, 43, 50, 51, 52,
            53, 60, 61, 62, 63, 70, 71, 72, 73,
        ];
        framebuffer
            .apply_scanout(4, 2, 16, PIXMAN_X8R8G8B8, initial)
            .unwrap();

        let update = [pixel(100), pixel(110)].concat();
        framebuffer
            .apply_update(1, 1, 2, 1, 8, PIXMAN_X8R8G8B8, update)
            .unwrap();

        let snapshot = framebuffer.take_snapshot_if_dirty().unwrap();
        assert_eq!(
            snapshot.data,
            vec![
                0, 1, 2, 3, 10, 11, 12, 13, 20, 21, 22, 23, 30, 31, 32, 33, 40, 41, 42, 43, 100,
                101, 102, 103, 110, 111, 112, 113, 70, 71, 72, 73,
            ]
        );
    }

    #[test]
    fn repacks_strided_frame_for_ffmpeg() {
        let snapshot = FrameSnapshot {
            width: 2,
            height: 2,
            stride: 12,
            format: PixelFormat::Bgr0,
            generation: 1,
            data: vec![
                1, 2, 3, 4, 5, 6, 7, 8, 99, 98, 97, 96, 10, 11, 12, 13, 14, 15, 16, 17, 88, 87, 86,
                85,
            ],
        };
        assert_eq!(
            snapshot.packed_bytes(),
            vec![1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17]
        );
    }
}
