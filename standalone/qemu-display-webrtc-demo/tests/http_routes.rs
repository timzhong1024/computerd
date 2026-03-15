use qemu_display_webrtc_demo::INDEX_HTML;

#[test]
fn example_page_contains_webrtc_bootstrap() {
    assert!(INDEX_HTML.contains("RTCPeerConnection"));
    assert!(INDEX_HTML.contains("/ws"));
    assert!(INDEX_HTML.contains("video"));
}
