use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tokio::sync::mpsc;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum SignalMessage {
    Offer { sdp: String },
    Answer { sdp: String },
    Ice { candidate: IceCandidate },
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct IceCandidate {
    pub candidate: String,
    #[serde(rename = "sdpMLineIndex")]
    pub sdp_m_line_index: u32,
    #[serde(rename = "sdpMid", skip_serializing_if = "Option::is_none")]
    pub sdp_mid: Option<String>,
}

#[derive(Debug, Default)]
pub struct SingleViewerGate {
    active: AtomicBool,
}

impl SingleViewerGate {
    pub fn try_acquire(self: &Arc<Self>) -> Option<ViewerLease> {
        self.active
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .ok()?;
        Some(ViewerLease {
            gate: Arc::clone(self),
        })
    }
}

pub struct ViewerLease {
    gate: Arc<SingleViewerGate>,
}

impl Drop for ViewerLease {
    fn drop(&mut self) {
        self.gate.active.store(false, Ordering::SeqCst);
    }
}

#[cfg(feature = "runtime")]
mod runtime {
    use anyhow::{Context, Result, anyhow};
    use glib::prelude::*;
    use gstreamer as gst;
    use gstreamer::prelude::*;
    use gstreamer_sdp as gst_sdp;
    use gstreamer_webrtc as gst_webrtc;

    use super::*;

    pub struct WebRtcSession {
        pipeline: gst::Pipeline,
        webrtcbin: gst_webrtc::WebRTCBin,
    }

    impl WebRtcSession {
        pub fn new(rtp_port: u16, outgoing: mpsc::UnboundedSender<SignalMessage>) -> Result<Self> {
            gst::init().context("failed to initialize GStreamer")?;

            let pipeline = gst::Pipeline::new();
            let udpsrc = gst::ElementFactory::make("udpsrc")
                .name("rtp-source")
                .build()
                .context("failed to create udpsrc")?;
            let queue = gst::ElementFactory::make("queue")
                .name("rtp-queue")
                .build()
                .context("failed to create queue")?;
            let webrtcbin = gst::ElementFactory::make("webrtcbin")
                .name("webrtcbin")
                .build()
                .context("failed to create webrtcbin")?
                .downcast::<gst_webrtc::WebRTCBin>()
                .map_err(|_| anyhow!("failed to downcast webrtcbin"))?;

            let caps = gst::Caps::builder("application/x-rtp")
                .field("media", "video")
                .field("encoding-name", "H264")
                .field("payload", 96i32)
                .field("clock-rate", 90000i32)
                .build();

            udpsrc.set_property("port", i32::from(rtp_port));
            udpsrc.set_property("caps", &caps);
            webrtcbin.set_property("bundle-policy", gst_webrtc::WebRTCBundlePolicy::MaxBundle);

            pipeline.add_many([&udpsrc, &queue, webrtcbin.upcast_ref()])?;
            gst::Element::link_many([&udpsrc, &queue])?;

            let src_pad = queue
                .static_pad("src")
                .context("queue src pad unavailable")?;
            let sink_pad = webrtcbin
                .request_pad_simple("sink_%u")
                .context("webrtc sink pad unavailable")?;
            src_pad.link(&sink_pad)?;

            let outgoing_ice = outgoing.clone();
            webrtcbin.connect_on_ice_candidate(move |_, sdp_m_line_index, candidate| {
                let _ = outgoing_ice.send(SignalMessage::Ice {
                    candidate: IceCandidate {
                        candidate: candidate.to_string(),
                        sdp_m_line_index,
                        sdp_mid: None,
                    },
                });
            });

            pipeline
                .set_state(gst::State::Playing)
                .context("failed to start webrtc pipeline")?;

            let session = Self {
                pipeline,
                webrtcbin,
            };
            session.create_offer(outgoing)?;
            Ok(session)
        }

        fn create_offer(&self, outgoing: mpsc::UnboundedSender<SignalMessage>) -> Result<()> {
            let webrtcbin = self.webrtcbin.clone();
            let promise = gst::Promise::with_change_func(move |reply| {
                let Ok(Some(reply)) = reply else {
                    return;
                };
                let Ok(offer) = reply.get::<gst_webrtc::WebRTCSessionDescription>("offer") else {
                    return;
                };
                webrtcbin
                    .emit_by_name::<()>("set-local-description", &[&offer, &None::<gst::Promise>]);
                let _ = outgoing.send(SignalMessage::Offer {
                    sdp: offer.sdp().as_text().unwrap_or_default().to_string(),
                });
            });

            self.webrtcbin
                .emit_by_name::<()>("create-offer", &[&None::<gst::Structure>, &promise]);
            Ok(())
        }

        pub fn apply_remote_answer(&self, sdp: &str) -> Result<()> {
            let message = gst_sdp::SDPMessage::parse_buffer(sdp.as_bytes())
                .map_err(|_| anyhow!("failed to parse remote answer SDP"))?;
            let answer = gst_webrtc::WebRTCSessionDescription::new(
                gst_webrtc::WebRTCSDPType::Answer,
                message,
            );
            self.webrtcbin
                .emit_by_name::<()>("set-remote-description", &[&answer, &None::<gst::Promise>]);
            Ok(())
        }

        pub fn add_ice_candidate(&self, candidate: &IceCandidate) {
            self.webrtcbin.emit_by_name::<()>(
                "add-ice-candidate",
                &[&candidate.sdp_m_line_index, &candidate.candidate],
            );
        }
    }

    impl Drop for WebRtcSession {
        fn drop(&mut self) {
            let _ = self.pipeline.set_state(gst::State::Null);
        }
    }

    pub use WebRtcSession as RuntimeWebRtcSession;
}

#[cfg(feature = "runtime")]
pub use runtime::RuntimeWebRtcSession as WebRtcSession;

pub async fn recv_signal(
    receiver: &mut mpsc::UnboundedReceiver<SignalMessage>,
) -> Option<SignalMessage> {
    receiver.recv().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_signal_messages() {
        let offer: SignalMessage = serde_json::from_str(r#"{"type":"offer","sdp":"v=0"}"#).unwrap();
        assert_eq!(offer, SignalMessage::Offer { sdp: "v=0".into() });

        let ice: SignalMessage = serde_json::from_str(
      r#"{"type":"ice","candidate":{"candidate":"candidate:1 1 UDP 2122260223 10.0.0.1 12345 typ host","sdpMLineIndex":0,"sdpMid":"0"}}"#,
    )
    .unwrap();
        assert!(matches!(ice, SignalMessage::Ice { .. }));
    }

    #[test]
    fn enforces_single_viewer() {
        let gate = Arc::new(SingleViewerGate::default());
        let lease = gate.try_acquire().expect("first lease");
        assert!(gate.try_acquire().is_none());
        drop(lease);
        assert!(gate.try_acquire().is_some());
    }
}
