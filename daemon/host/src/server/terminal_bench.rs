//! Opt-in, disposable full RPC/PTY transport experiment; not a browser benchmark.
use super::*;
use rieul_daemon_core::rpc::{TerminalLaunchSpec, TerminalSessionInfo};
use std::time::Instant;

struct Reader {
    recv: web_transport_quinn::RecvStream,
    pending: Vec<u8>,
    output_bytes: usize,
    x_bytes: usize,
    last_seq: Option<u64>,
}
impl Reader {
    async fn next(&mut self) -> Result<ReqResMessage> {
        tokio::time::timeout(Duration::from_secs(120), async {
            loop {
                if let Some((message, n)) = ReqResMessage::decode_prefix(&self.pending)? {
                    self.pending.drain(..n);
                    return Ok(message);
                }
                let mut bytes = [0; 16384];
                let n = self
                    .recv
                    .read(&mut bytes)
                    .await?
                    .context("unexpected stream end")?;
                self.pending.extend_from_slice(&bytes[..n]);
            }
        })
        .await
        .context("response timed out")?
    }
    async fn event(&mut self) -> Result<TerminalEvent> {
        match self.next().await? {
            ReqResMessage::ResponseStreamStart {
                payload: Some(bytes),
            }
            | ReqResMessage::ResponseStreamChunk { payload: bytes } => {
                Ok(TerminalEvent::decode(&bytes)?)
            }
            other => bail!("unexpected terminal response: {other:?}"),
        }
    }
    async fn marker(&mut self, parser: &mut vt100::Parser, marker: &str) -> Result<u64> {
        loop {
            match self.event().await? {
                TerminalEvent::OutputChunk { seq, bytes } => {
                    if let Some(last) = self.last_seq {
                        anyhow::ensure!(seq == last + 1, "output sequence gap or reorder");
                    }
                    self.last_seq = Some(seq);
                    self.x_bytes += bytes.iter().filter(|&&byte| byte == b'x').count();
                    self.output_bytes += bytes.len();
                    parser.process(&bytes);
                    if parser.screen().contents().contains(marker) {
                        return Ok(seq);
                    }
                }
                TerminalEvent::ScreenSnapshot {
                    base_seq, bytes, ..
                } => {
                    self.last_seq = Some(base_seq);
                    self.output_bytes += bytes.len();
                    parser.process(&bytes);
                    if parser.screen().contents().contains(marker) {
                        return Ok(base_seq);
                    }
                }
                TerminalEvent::HistoryGap { .. } => bail!("unexpected history gap"),
                _ => {}
            }
        }
    }
}
async fn invoke(session: &web_transport_quinn::Session, message: ReqResMessage) -> Result<Reader> {
    let (mut send, recv) = session.open_bi().await?;
    send.write_all(&message.encode()).await?;
    send.finish()?;
    Ok(Reader {
        recv,
        pending: vec![],
        output_bytes: 0,
        x_bytes: 0,
        last_seq: None,
    })
}
async fn unary(
    session: &web_transport_quinn::Session,
    proc: ProcId,
    payload: Vec<u8>,
) -> Result<Vec<u8>> {
    match invoke(
        session,
        ReqResMessage::RequestUnary {
            proc_id: proc.as_u64(),
            payload: Some(payload),
        },
    )
    .await?
    .next()
    .await?
    {
        ReqResMessage::ResponseUnaryOk { payload } => Ok(payload.unwrap_or_default()),
        other => bail!("unexpected unary response: {other:?}"),
    }
}
async fn attach(
    session: &web_transport_quinn::Session,
    id: &str,
    after_seq: Option<u64>,
) -> Result<(Reader, String)> {
    let started = Instant::now();
    let mut reader = invoke(
        session,
        ReqResMessage::RequestUnary {
            proc_id: ProcId::AttachTerminalSession.as_u64(),
            payload: Some(
                AttachTerminalSessionReq {
                    terminal_session_id: id.into(),
                    after_seq,
                    viewport_cols: 80,
                    viewport_rows: 24,
                    screen_snapshots: Some(true),
                }
                .encode(),
            ),
        },
    )
    .await?;
    reader.last_seq = after_seq;
    match reader.event().await? {
        TerminalEvent::Attached { attach_id, .. } => {
            println!(
                "attach_response_ms={:.3}",
                started.elapsed().as_secs_f64() * 1000.0
            );
            Ok((reader, attach_id))
        }
        other => bail!("unexpected attach: {other:?}"),
    }
}
async fn control(
    session: &web_transport_quinn::Session,
    id: &str,
    attach_id: &str,
) -> Result<web_transport_quinn::SendStream> {
    let started = Instant::now();
    unary(
        session,
        ProcId::TakeTerminalControl,
        TakeTerminalControlReq {
            terminal_session_id: id.into(),
            attach_id: attach_id.into(),
            viewport_cols: 80,
            viewport_rows: 24,
        }
        .encode(),
    )
    .await?;
    println!(
        "take_control_response_ms={:.3}",
        started.elapsed().as_secs_f64() * 1000.0
    );
    let started = Instant::now();
    let (mut send, _recv) = session.open_bi().await?;
    send.write_all(
        &ReqResMessage::RequestStreamStart {
            proc_id: ProcId::WriteTerminalInput.as_u64(),
            payload: Some(
                WriteTerminalInputReq::Start {
                    terminal_session_id: id.into(),
                    attach_id: attach_id.into(),
                }
                .encode(),
            ),
        }
        .encode(),
    )
    .await?;
    println!(
        "input_start_enqueue_ms={:.3}",
        started.elapsed().as_secs_f64() * 1000.0
    );
    Ok(send)
}
async fn input(send: &mut web_transport_quinn::SendStream, bytes: &[u8]) -> Result<()> {
    send.write_all(
        &ReqResMessage::RequestStreamChunk {
            payload: WriteTerminalInputReq::Chunk {
                bytes: bytes.into(),
            }
            .encode(),
        }
        .encode(),
    )
    .await?;
    Ok(())
}
fn quantile(values: &mut [f64], fraction: f64) -> f64 {
    values.sort_by(f64::total_cmp);
    values[((values.len() - 1) as f64 * fraction).ceil() as usize]
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "manual loopback terminal transport benchmark"]
async fn terminal_transport_measurement() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let cert = rcgen::generate_simple_self_signed(vec!["localhost".into()])?;
    fs::write(dir.path().join("cert.pem"), cert.cert.pem())?;
    fs::write(dir.path().join("key.pem"), cert.signing_key.serialize_pem())?;
    let socket = std::net::UdpSocket::bind("127.0.0.1:0")?;
    let port = socket.local_addr()?.port();
    drop(socket);
    let config_path = dir.path().join("rieul.yaml");
    save(
        &config_path,
        &SystemConfig {
            listen_addr: format!("127.0.0.1:{port}"),
            domain: None,
            tls: Some(rieul_daemon_core::config::TlsConfig {
                cert_file: "cert.pem".into(),
                key_file: "key.pem".into(),
            }),
            ..Default::default()
        },
    )?;
    let issued = issue_client_secret("disposable transport fixture", now_unix());
    save_client_credentials(
        &client_credentials_path(&config_path),
        &ClientCredentials {
            clients: vec![issued.record],
        },
    )?;
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let ready_tx = std::sync::Mutex::new(Some(ready_tx));
    let shell_dir = dir.path().join("shell");
    let daemon = tokio::spawn(async move {
        run_system_server_with_readiness(
            None,
            config_path,
            tests::test_files(),
            None,
            None,
            None,
            None,
            None,
            Some(Arc::new(crate::terminal::LocalTerminalBackend::new(
                shell_dir,
            ))),
            None,
            "benchmark",
            Some(Arc::new(move || {
                if let Some(tx) = ready_tx.lock().unwrap().take() {
                    let _ = tx.send(());
                }
                Ok(())
            })),
            None,
            None,
        )
        .await
        .unwrap();
    });
    let _daemon_guard = AbortTaskOnDrop(daemon);
    tokio::time::timeout(Duration::from_secs(10), ready_rx).await??;
    // The relay changes only this disposable loopback path, never host networking.
    let relay = std::process::Command::new("python3")
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tools/terminal-bench/udp_relay.py"
        ))
        .args([
            "--listen",
            "0",
            "--server",
            &port.to_string(),
            "--rtt-ms",
            &std::env::var("RIEUL_BENCH_RTT_MS").unwrap_or("0".into()),
            "--down-bps",
            &std::env::var("RIEUL_BENCH_DOWN_BPS").unwrap_or("0".into()),
            "--loss",
            &std::env::var("RIEUL_BENCH_LOSS").unwrap_or("0".into()),
            "--seed",
            "42",
        ])
        .stdout(std::process::Stdio::piped())
        .spawn()?;
    struct Relay(std::process::Child);
    impl Drop for Relay {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let mut relay = Relay(relay);
    let mut line = String::new();
    std::io::BufRead::read_line(
        &mut std::io::BufReader::new(relay.0.stdout.take().unwrap()),
        &mut line,
    )?;
    let proxy_port: u16 = line
        .split_whitespace()
        .last()
        .context("relay startup")?
        .parse()?;
    println!(
        "profile rtt_ms={} down_bps={} loss={}",
        std::env::var("RIEUL_BENCH_RTT_MS").unwrap_or("0".into()),
        std::env::var("RIEUL_BENCH_DOWN_BPS").unwrap_or("0".into()),
        std::env::var("RIEUL_BENCH_LOSS").unwrap_or("0".into())
    );
    let client = web_transport_quinn::ClientBuilder::new()
        .with_server_certificates(vec![cert.cert.der().clone()])?;
    let mut session = client
        .connect(url::Url::parse(&format!(
            "https://127.0.0.1:{proxy_port}/rieul/rpc"
        ))?)
        .await?;
    let auth = ReqResMessage::SessionAuthenticate {
        mechanism: PAIRED_SECRET_AUTH_MECHANISM.into(),
        payload: PairedSecretCredential {
            credential_id: issued.client_id,
            credential_secret: issued.client_secret,
        }
        .encode(),
    };
    anyhow::ensure!(matches!(
        invoke(&session, auth.clone()).await?.next().await?,
        ReqResMessage::SessionAuthenticated
    ));
    let script="import os,tty,signal\nsignal.alarm(180)\ntty.setraw(0)\nos.write(1,b'READY')\nwhile True:\n b=os.read(0,1)\n if b==b'!':\n  for i in range(512): os.write(1,b'x'*4096)\n  os.write(1,b'\\r\\nBULK-DONE')\n else: os.write(1,b'\\r\\nECHO-'+b)\n";
    let info = TerminalSessionInfo::decode(
        &unary(
            &session,
            ProcId::CreateTerminalSession,
            CreateTerminalSessionReq {
                cols: 80,
                rows: 24,
                cwd: Some(dir.path().to_string_lossy().into()),
                launch: TerminalLaunchSpec {
                    command: "/usr/bin/python3".into(),
                    args: vec!["-u".into(), "-c".into(), script.into()],
                },
                title: Some("disposable benchmark".into()),
            }
            .encode(),
        )
        .await?,
    )?;
    let id = &info.terminal_session_id;
    let result = async {
        let (mut reader, attach_id) = attach(&session, id, None).await?;
        let mut parser = vt100::Parser::new(24, 80, 0);
        reader.marker(&mut parser, "READY").await?;
        let mut send = control(&session, id, &attach_id).await?;
        let mut times = vec![];
        for n in 0..100 {
            let byte = b'A' + (n % 26) as u8;
            let start = Instant::now();
            input(&mut send, &[byte]).await?;
            reader
                .marker(&mut parser, &format!("ECHO-{}", byte as char))
                .await?;
            times.push(start.elapsed().as_secs_f64() * 1000.0);
            parser = vt100::Parser::new(24, 80, 0);
        }
        println!(
            "echo_samples=100 p50_ms={:.3} p95_ms={:.3}",
            quantile(&mut times, 0.5),
            quantile(&mut times, 0.95)
        );
        let before = reader.output_bytes;
        let stats_before = web_transport_quinn::quinn::Connection::stats(&session);
        input(&mut send, b"!").await?;
        tokio::time::sleep(Duration::from_millis(500)).await;
        let pause_stats = web_transport_quinn::quinn::Connection::stats(&session);
        let start = Instant::now();
        let last_seq = reader.marker(&mut parser, "BULK-DONE").await?;
        let stats = web_transport_quinn::quinn::Connection::stats(&session);
        println!("bulk_udp_rx_bytes={} pause_udp_rx_bytes={} stream_blocked_frames={} connection_blocked_frames={} quic_rtt_ms={:.3}",stats.udp_rx.bytes-stats_before.udp_rx.bytes,pause_stats.udp_rx.bytes-stats_before.udp_rx.bytes,stats.frame_rx.stream_data_blocked-stats_before.frame_rx.stream_data_blocked,stats.frame_rx.data_blocked-stats_before.frame_rx.data_blocked,stats.path.rtt.as_secs_f64()*1000.0);
        println!("bulk_payload_bytes=2097152 decoded_output_bytes={} read_pause_ms=500 drain_after_pause_ms={:.3}",reader.output_bytes-before,start.elapsed().as_secs_f64()*1000.0);
        anyhow::ensure!(
            reader.output_bytes - before == 2097152 + 11,
            "incorrect burst byte count"
        );
        anyhow::ensure!(reader.x_bytes == 2097152, "incorrect burst contents");
        reader.recv.stop(0)?;
        drop(send);
        let start = Instant::now();
        let (mut resumed, attach_id) = attach(&session, id, Some(last_seq)).await?;
        let mut send = control(&session, id, &attach_id).await?;
        input(&mut send, b"R").await?;
        let last_seq = resumed.marker(&mut parser, "ECHO-R").await?;
        println!(
            "same_connection_reattach_first_echo_ms={:.3}",
            start.elapsed().as_secs_f64() * 1000.0
        );
        resumed.recv.stop(0)?;
        drop(send);
        session.close(0, b"reconnect fixture");
        let start = Instant::now();
        let connect_started = Instant::now();
        session = client
            .connect(url::Url::parse(&format!(
                "https://127.0.0.1:{proxy_port}/rieul/rpc"
            ))?)
            .await?;
        println!(
            "new_connect_ms={:.3}",
            connect_started.elapsed().as_secs_f64() * 1000.0
        );
        let auth_started = Instant::now();
        anyhow::ensure!(matches!(
            invoke(&session, auth.clone()).await?.next().await?,
            ReqResMessage::SessionAuthenticated
        ));
        println!(
            "new_auth_response_ms={:.3}",
            auth_started.elapsed().as_secs_f64() * 1000.0
        );
        let (mut resumed, attach_id) = attach(&session, id, Some(last_seq)).await?;
        let mut send = control(&session, id, &attach_id).await?;
        let echo_started = Instant::now();
        input(&mut send, b"S").await?;
        parser = vt100::Parser::new(24, 80, 0);
        resumed.marker(&mut parser, "ECHO-S").await?;
        println!(
            "new_first_input_marker_ms={:.3}",
            echo_started.elapsed().as_secs_f64() * 1000.0
        );
        println!(
            "new_connection_auth_reattach_first_echo_ms={:.3}",
            start.elapsed().as_secs_f64() * 1000.0
        );

        Ok::<(), anyhow::Error>(())
    }
    .await;
    let cleanup = unary(
        &session,
        ProcId::CloseTerminalSession,
        CloseTerminalSessionReq {
            terminal_session_id: id.clone(),
        }
        .encode(),
    )
    .await;
    if result.is_ok() {
        cleanup?;
    }

    session.close(0, b"done");
    result
}
