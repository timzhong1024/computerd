# qemu-display-webrtc-demo

一个与 `computerd` 完全无关的独立 demo。

目标：

- 从单个 `QEMU` 实例的 `-display dbus` 输出读取屏幕内容
- 把屏幕编码成 `WebRTC` 视频流
- 在自带 example webpage 中验证可播放

当前范围刻意很窄：

- 只支持 Linux host
- 只支持单个 QEMU console
- 只支持单个浏览器观看者
- 只发送视频，不做音频、键鼠输入、TURN/STUN、公网穿透、丢帧优化

## 前置依赖

本项目不假设以下依赖已安装；运行 `runtime` 功能前需要你自己准备：

- Rust toolchain
- QEMU，且构建包含 `-display dbus`
- FFmpeg，且包含 `libx264`
- GStreamer 运行时与 `webrtc` 相关插件
- Linux 上可用的 D-Bus / Unix socket 环境

## 构建

默认构建不启用运行时依赖，便于在没有安装系统媒体库时跑纯逻辑测试：

```bash
cargo test
```

要构建可运行的 demo，需要启用 `runtime` feature：

```bash
cargo build --features runtime
```

## 运行

示例：

```bash
cargo run --features runtime -- \
  --qemu-dbus-address /tmp/qemu-display.sock \
  --console-id 0 \
  --listen 127.0.0.1:8080 \
  --rtp-port 5004 \
  --fps 30
```

其中 `--qemu-dbus-address` 支持：

- QEMU 暴露的 Unix socket 路径
- D-Bus address 字符串，例如 `unix:path=/tmp/qemu-display.sock`

启动后访问：

```text
http://127.0.0.1:8080/
```

## 当前实现边界

- 优先消费 `ScanoutMap`，回退到普通 `Scanout`
- `ScanoutDMABUF` 只记录日志，不接入编码链路
- 只支持常见 32bpp pixman 格式
- FFmpeg 固定软编 `libx264`
- GStreamer 只承担 `WebRTC` 发送，不承担编码
