struct HostedScreenRecord {
    kind: u32,
    marker: u32,
    timestamp: u64,
    received: u64,
    applied: u64,
    captured: u64,
    ready: u64,
    index: u32,
    key: bool,
    payload: Vec<u8>,
}
fn read_hosted_screen_record(
    reader: &mut impl std::io::Read,
) -> std::io::Result<HostedScreenRecord> {
    let mut header = [0u8; 64];
    reader.read_exact(&mut header)?;
    let invalid = || {
        std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "invalid hosted screen record",
        )
    };
    if &header[..4] != b"RSL1" {
        return Err(invalid());
    }
    let u32_at = |at| u32::from_be_bytes(header[at..at + 4].try_into().unwrap());
    let u64_at = |at| u64::from_be_bytes(header[at..at + 8].try_into().unwrap());
    let kind = u32_at(4);
    let length = u32_at(8) as usize;
    if !(1..=6).contains(&kind)
        || length > 4 * 1024 * 1024
        || (kind != 2 && length > 65536)
        || u32_at(12) > 64
        || u32_at(60) > 1
    {
        return Err(invalid());
    }
    let mut payload = vec![0; length];
    reader.read_exact(&mut payload)?;
    Ok(HostedScreenRecord {
        kind,
        marker: u32_at(12),
        timestamp: u64_at(16),
        received: u64_at(24),
        applied: u64_at(32),
        captured: u64_at(40),
        ready: u64_at(48),
        index: u32_at(56),
        key: u32_at(60) == 1,
        payload,
    })
}
fn hosted_screen_allowed() -> bool {
    cfg!(all(target_os = "macos", target_arch = "aarch64"))
        && [
            ("GITHUB_ACTIONS", "true"),
            ("RUNNER_ENVIRONMENT", "github-hosted"),
            ("RUNNER_OS", "macOS"),
            ("RUNNER_ARCH", "ARM64"),
            ("GITHUB_REPOSITORY", "disjukr/rieul.app"),
            ("GITHUB_REF", "refs/heads/screen-hosted-live-scroll-test"),
            ("GITHUB_EVENT_NAME", "workflow_dispatch"),
            ("GITHUB_WORKFLOW", "Screen capture capability probe"),
            (
                "GITHUB_WORKFLOW_REF",
                "disjukr/rieul.app/.github/workflows/probe-screen-fixture.yml@refs/heads/screen-hosted-live-scroll-test",
            ),
            ("RIEUL_HOSTED_SCREEN_SCROLL", "1"),
        ]
        .iter()
        .all(|(name, expected)| std::env::var(name).as_deref() == Ok(*expected))
}
#[derive(Default)]
struct HostedScreenCounts {
    packets: u64,
    payload_bytes: u64,
    native_actions: std::collections::BTreeMap<u32, serde_json::Value>,
    native_frames: std::collections::BTreeMap<u64, serde_json::Value>,
}
struct HostedScreenSource {
    startup: serde_json::Value,
    writer: std::sync::Mutex<std::process::ChildStdin>,
    reader: std::sync::Mutex<std::io::BufReader<std::process::ChildStdout>>,
    child: std::sync::Mutex<std::process::Child>,
    codec: std::sync::Mutex<Option<String>>,
    closing: std::sync::atomic::AtomicBool,
    sequence: std::sync::atomic::AtomicU32,
    action: std::sync::atomic::AtomicU32,
    counts: std::sync::Mutex<HostedScreenCounts>,
    stopped: std::sync::Mutex<Option<bool>>,
    native_shutdown: std::sync::Mutex<Option<serde_json::Value>>,
}
impl HostedScreenSource {
    fn spawn() -> Self {
        assert!(
            hosted_screen_allowed(),
            "hosted Screen fixture refused outside exact manual runner"
        );
        let executable =
            PathBuf::from(std::env::var_os("RUNNER_TEMP").unwrap()).join("rieul-screen-live");
        let mut child = std::process::Command::new(executable)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let writer = child.stdin.take().unwrap();
        let mut reader = std::io::BufReader::new(child.stdout.take().unwrap());
        let startup = read_hosted_screen_record(&mut reader).unwrap();
        assert_eq!(
            startup.kind, 1,
            "native source did not provide startup status"
        );
        let startup = serde_json::from_slice(&startup.payload).unwrap();
        Self {
            startup,
            writer: std::sync::Mutex::new(writer),
            reader: std::sync::Mutex::new(reader),
            child: std::sync::Mutex::new(child),
            codec: Default::default(),
            closing: Default::default(),
            sequence: Default::default(),
            action: Default::default(),
            counts: Default::default(),
            stopped: Default::default(),
            native_shutdown: Default::default(),
        }
    }
    fn note_terminal(&self, record: &HostedScreenRecord) {
        if !matches!(record.kind, 4 | 5) {
            return;
        }
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&record.payload) else {
            return;
        };
        let reason = value["reason"]
            .as_str()
            .filter(|v| v.len() <= 96 && v.bytes().all(|c| c.is_ascii_lowercase() || c == b'_'))
            .unwrap_or("unclassified_native_terminal");
        *self.native_shutdown.lock().unwrap() = Some(serde_json::json!({
            "recordKind":record.kind,"reason":reason,
            "shutdownConfirmed":value["shutdownConfirmed"].as_bool(),
            "encodedPackets":value["encodedPackets"].as_u64(),
            "encodedBytes":value["encodedBytes"].as_u64(),
            "markerChecks":value["markerChecks"].as_u64(),
            "markerMatches":value["markerMatches"].as_u64()
        }));
    }
    fn codecs(&self) -> Vec<DesktopCodec> {
        ["hevcCodec", "h264Codec"]
            .into_iter()
            .filter_map(|key| {
                self.startup[key].as_str().map(|codec| DesktopCodec {
                    codec: codec.into(),
                    description: None,
                    hardware: true,
                })
            })
            .collect()
    }
    fn supports(&self, track: &DesktopTrack) -> bool {
        track.stripes.is_none()
            && track.viewport.width == 640
            && track.viewport.height == 480
            && track.viewport.fps == 60
            && track.viewport.bitrate == 20_000_000
            && self.codecs().iter().any(|c| c.codec == track.codec.codec)
    }
    fn command(&self, command: &str) -> Result<(), desktop::Error> {
        use std::io::Write;
        let mut writer = self.writer.lock().map_err(|_| desktop::Error::Backend)?;
        if command != "STOP\n" && self.closing.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(desktop::Error::Stale);
        }
        writer
            .write_all(command.as_bytes())
            .map_err(|_| desktop::Error::Backend)
    }

    fn scroll(&self) -> Result<(), desktop::Error> {
        let id = self
            .action
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1;
        if id > 45 {
            return Err(desktop::Error::Limit);
        }
        self.command(&format!("SCROLL {id}\n"))
    }
    fn observe(&self, frame: &HostedScreenRecord) -> Result<(), desktop::Error> {
        if frame.timestamp == 0
            || frame.payload.is_empty()
            || frame.index >= 60
            || frame.key != (frame.index == 0)
            || frame.captured > frame.ready
            || frame.applied > frame.captured
            || frame.received > frame.applied
        {
            return Err(desktop::Error::Invalid);
        }
        let mut counts = self.counts.lock().map_err(|_| desktop::Error::Backend)?;
        counts.packets += 1;
        counts.payload_bytes += frame.payload.len() as u64;
        if frame.marker > 0 && frame.applied > 0 {
            counts
                .native_actions
                .entry(frame.marker)
                .or_insert_with(|| {
                    serde_json::json!({
                        "id": frame.marker, "frameTimestampMicros": frame.timestamp,
                        "receivedToAppliedMicros": frame.applied - frame.received,
                        "appliedToMarkerReadMicros": frame.captured - frame.applied,
                        "markerReadToPacketCallbackMicros": frame.ready - frame.captured,
                        "clock": "native CLOCK_UPTIME_RAW; no browser-clock subtraction"
                    })
                });
        }
        if frame.marker > 0 {
            if counts.native_frames.len() >= 4096 {
                return Err(desktop::Error::Limit);
            }
            counts.native_frames.insert(
                frame.timestamp,
                serde_json::json!({
                    "id": frame.marker, "frameTimestampMicros": frame.timestamp,
                    "receivedToAppliedMicros": frame.applied - frame.received,
                    "appliedToMarkerReadMicros": frame.captured - frame.applied,
                    "markerReadToPacketCallbackMicros": frame.ready - frame.captured
                }),
            );
        }
        Ok(())
    }
    fn stream(
        &self,
        track: &DesktopTrack,
        emit: &mut dyn FnMut(desktop::EncodedFrame) -> Result<(), desktop::Error>,
    ) -> Result<(), desktop::Error> {
        if self.closing.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(desktop::Error::Stale);
        }
        if !self.supports(track) {
            return Err(desktop::Error::Unsupported);
        }
        let mut reader = self.reader.lock().map_err(|_| desktop::Error::Backend)?;
        let mut codec = self.codec.lock().map_err(|_| desktop::Error::Backend)?;
        if codec.as_ref().is_some_and(|c| c != &track.codec.codec) {
            return Err(desktop::Error::Unsupported);
        }
        if codec.is_none() {
            self.command(if track.codec.codec.starts_with("hev1.") {
                "START hevc\n"
            } else {
                "START h264\n"
            })?;
            let ack =
                read_hosted_screen_record(&mut *reader).map_err(|_| desktop::Error::Backend)?;
            if ack.kind != 6 {
                self.note_terminal(&ack);
                return Err(desktop::Error::Backend);
            }
            let ack: serde_json::Value =
                serde_json::from_slice(&ack.payload).map_err(|_| desktop::Error::Invalid)?;
            if ack["status"] != "started" || ack["codec"] != track.codec.codec {
                return Err(desktop::Error::Backend);
            }
            *codec = Some(track.codec.codec.clone());
        }
        drop(codec);
        let sequence = self
            .sequence
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1;
        self.command(&format!("GROUP {sequence} 60\n"))?;
        let mut delivery_error = None;
        let mut index = 0;
        loop {
            let record =
                read_hosted_screen_record(&mut *reader).map_err(|_| desktop::Error::Backend)?;
            match record.kind {
                2 => {
                    if record.index != index {
                        return Err(desktop::Error::Invalid);
                    }
                    index += 1;
                    self.observe(&record)?;
                    if delivery_error.is_none() {
                        delivery_error = emit(desktop::EncodedFrame::new(
                            record.timestamp,
                            record.key,
                            record.payload,
                        ))
                        .err();
                    }
                }
                3 => {
                    let end: serde_json::Value = serde_json::from_slice(&record.payload)
                        .map_err(|_| desktop::Error::Invalid)?;
                    if end["sequence"].as_u64() != Some(sequence as u64)
                        || end["packets"].as_u64() != Some(index as u64)
                    {
                        return Err(desktop::Error::Invalid);
                    }
                    if self.closing.load(std::sync::atomic::Ordering::SeqCst) {
                        return Err(desktop::Error::Stale);
                    }
                    return delivery_error.map_or_else(
                        || {
                            if end["status"] == "complete"
                                || (index > 0
                                    && end["status"] == "ended_early"
                                    && end["reason"] == "unexpected_keyframe")
                            {
                                Ok(())
                            } else {
                                Err(desktop::Error::Backend)
                            }
                        },
                        Err,
                    );
                }
                _ => {
                    self.note_terminal(&record);
                    return Err(desktop::Error::Backend);
                }
            }
        }
    }
    fn stop(&self) -> bool {
        let Ok(mut stopped) = self.stopped.lock() else {
            return false;
        };
        if let Some(result) = *stopped {
            return result;
        }
        self.closing
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let sent = self.command("STOP\n").is_ok();
        let record = self
            .reader
            .lock()
            .ok()
            .and_then(|mut reader| read_hosted_screen_record(&mut *reader).ok());
        if let Some(record) = record.as_ref() {
            self.note_terminal(record);
        }
        let native = self.native_shutdown.lock().unwrap().clone();
        let confirmed = native.as_ref().is_some_and(|j| {
            let counts = self.counts.lock().unwrap();
            j["recordKind"] == 5
                && j["shutdownConfirmed"] == true
                && j["encodedPackets"].as_u64() == Some(counts.packets)
                && j["encodedBytes"].as_u64() == Some(counts.payload_bytes)
                && j["markerChecks"] == j["markerMatches"]
        });
        let exited = self
            .child
            .lock()
            .ok()
            .and_then(|mut c| c.wait().ok())
            .is_some_and(|s| s.success());
        let result = sent && confirmed && exited;
        *stopped = Some(result);
        result
    }
    fn summary(
        &self,
        shutdown: bool,
        browser: &serde_json::Value,
        browser_ok: bool,
    ) -> serde_json::Value {
        let counts = self.counts.lock().unwrap();
        let presented = browser["samples"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|sample| {
                let timestamp = sample["frameTimestampMicros"].as_u64()?;
                let native = counts.native_frames.get(&timestamp)?;
                (native["id"] == sample["id"]).then_some(native.clone())
            })
            .collect::<Vec<_>>();
        serde_json::json!({"nativePresentedSamples":presented,"nativeShutdown":*self.native_shutdown.lock().unwrap(),"scope":"actual native capture/encode -> production IPC codec over in-memory fixture -> authenticated localhost WebTransport -> browser canvas; installed macOS helper peer-auth/socket/privilege overhead and physical scanout unmeasured", "status":if shutdown && browser_ok && browser["status"] == "passed" && presented.len() == 40 {"passed"} else {"failed"}, "nativeStartup":self.startup, "encodedPackets":counts.packets,"encodedPayloadBytes":counts.payload_bytes,"nativeActions":counts.native_actions.values().collect::<Vec<_>>(),"shutdownProtocolSucceeded":shutdown,"wireBytes":null,"captureMode":"test-only marker-gated fixed-rate full-frame; production damage/paintover/adaptive-rate policy not exercised"})
    }
}
impl Drop for HostedScreenSource {
    fn drop(&mut self) {
        if let Ok(child) = self.child.get_mut() {
            if child.try_wait().ok().flatten().is_none() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}
#[test]
fn hosted_screen_record_rejects_unbounded_and_nonfixture_payloads() {
    let mut header = [0u8; 64];
    assert!(read_hosted_screen_record(&mut &header[..]).is_err());
    header[..4].copy_from_slice(b"RSL1");
    header[4..8].copy_from_slice(&2u32.to_be_bytes());
    header[8..12].copy_from_slice(&(4u32 * 1024 * 1024 + 1).to_be_bytes());
    assert!(read_hosted_screen_record(&mut &header[..]).is_err());
    header[8..12].copy_from_slice(&1u32.to_be_bytes());
    let mut bytes = header.to_vec();
    bytes.push(42);
    let record = read_hosted_screen_record(&mut &bytes[..]).unwrap();
    assert_eq!(record.payload, [42]);
}
fn hosted_screen_skip_result(startup: &serde_json::Value) -> serde_json::Value {
    let mut readiness = serde_json::Map::new();
    for key in [
        "screenMatches",
        "frameMatches",
        "windowVisible",
        "occlusionVisible",
        "applicationActive",
    ] {
        if let Some(value) = startup["readiness"][key].as_bool() {
            readiness.insert(key.into(), value.into());
        }
    }
    let reason = startup["reason"]
        .as_str()
        .filter(|v| v.len() <= 96 && v.bytes().all(|c| c.is_ascii_lowercase() || c == b'_'))
        .unwrap_or("native_fixture_unavailable");
    serde_json::json!({"kind":"hosted_screen_scroll_result","status":"skipped","functionalResult":"not_run","performanceResult":"not_measured","reason":reason,"readiness":readiness})
}
#[test]
fn hosted_screen_skip_has_no_performance_numbers() {
    let result = hosted_screen_skip_result(
        &serde_json::json!({"reason":"synthetic_window_not_visible_on_target_screen","width":640,"fpsTarget":60,"probeWallMs":2,"readiness":{"windowVisible":false,"applicationActive":true}}),
    );
    assert_eq!(result["status"], "skipped");
    assert_eq!(result["performanceResult"], "not_measured");
    assert_eq!(result["readiness"]["windowVisible"], false);
    assert!(!result.to_string().chars().any(|c| c.is_ascii_digit()));
}
#[cfg(target_os = "macos")]
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "manual hosted disposable synthetic capture only; never run on a personal Mac"]
async fn browser_live_hosted_scroll() {
    assert!(
        hosted_screen_allowed(),
        "hosted Screen fixture refused outside exact manual runner"
    );
    let source = Arc::new(HostedScreenSource::spawn());
    if source.startup["status"] == "skipped" {
        let result = hosted_screen_skip_result(&source.startup);
        println!("{}", result);
        println!(
            "::notice title=SKIPPED Screen scroll scenario::Not a functional pass; no performance measurements. Reason {}",
            result["reason"].as_str().unwrap()
        );
        if let Some(path) = std::env::var_os("GITHUB_STEP_SUMMARY") {
            use std::io::Write;
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
            {
                let _ = writeln!(
                    file,
                    "## SKIPPED Screen scroll scenario\nNot a functional pass. No performance measurements were collected.\nReason: `{}`.",
                    result["reason"].as_str().unwrap()
                );
            }
        }
        return;
    }
    assert_eq!(source.startup["status"], "ready");
    let f = Fixture::with_ipc(true).await;
    *f.backend.live_source.lock().unwrap() = Some(source.clone());
    let address = load_or_default(&f._dir.path().join("rieul.yaml"))
        .unwrap()
        .listen_addr;
    let metadata = f._dir.path().join("hosted-screen-browser.json");
    std::fs::write(&metadata,serde_json::to_vec(&serde_json::json!({"url":format!("https://{address}/rieul/rpc"),"hash":f.certificate_hash,"clientId":f.client_id,"secret":f.secret,"live":true})).unwrap()).unwrap();
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../scripts/testing/hosted-screen-browser.mjs");
    let browser = tokio::process::Command::new("node")
        .arg(script)
        .arg(metadata)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let output = tokio::time::timeout(Duration::from_secs(60), browser.wait_with_output()).await;
    let mut browser_result = serde_json::json!({"kind":"hosted_screen_browser","status":"failed","failure":"browser_process_or_summary"});
    let browser_ok = if let Ok(Ok(output)) = output {
        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&output.stdout) {
            browser_result = value;
        }
        output.status.success() && browser_result["status"] == "passed"
    } else {
        false
    };
    println!("{}", browser_result);
    let shutdown = tokio::task::spawn_blocking({
        let source = source.clone();
        move || source.stop()
    })
    .await
    .unwrap();
    let summary = source.summary(shutdown, &browser_result, browser_ok);
    println!("{}", summary);
    assert!(browser_ok, "browser live fixture failed");
    assert_eq!(
        summary["nativePresentedSamples"].as_array().map(Vec::len),
        Some(40),
        "missing native timing for a visually completed sample"
    );
    assert!(shutdown, "native fixture shutdown protocol failed");
    assert_eq!(source.action.load(std::sync::atomic::Ordering::SeqCst), 45);
    assert_eq!(source.counts.lock().unwrap().native_actions.len(), 45);
}
