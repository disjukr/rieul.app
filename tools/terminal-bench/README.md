# Terminal performance baseline

Run the deterministic output scheduler model and local Unix PTY echo floor:

```sh
node tools/terminal-bench/model.mjs
python3 tools/terminal-bench/pty_echo.py
python3 tools/terminal-bench/test_udp_relay.py
```

**These aren't transport benchmarks.** The model holds source, delay and link
capacity constant and varies only a queue policy. It excludes loss,
compression, QUIC flow/congestion control, CPU, browser rendering, wire
headers, resizes and input delivery (the slow-observer case uses an assumed 25 ms application cost). Local Linux/macOS PTY echo uses the kernel
line discipline and excludes the shell, daemon and browser. Do not compare
these numbers with measured rsh results.

Reference: Rieul 3ba2f1793e621816bd73d16fac3862da92e8d0e8;
rsh [110038b](https://github.com/enif-lee/rsh/blob/110038b137c29929c38b034737aacaa87ab51b1b/BENCHMARK.md).
The rsh harness uses different observer paths in some arms, a frame header
rather than a completed frame, and two static samples per case.

The synthetic dashboard emits 1,500 bytes at 60/s. At 512 kbit/s,
200 ms RTT, its continuous writes need about 23 ms each. A sender with
enough buffering can remain well under the 5 s single-write timeout while
falling seconds behind; the 30 s producer also emits fewer than the 4,096
event slots in Rieul's terminal ring. The staged model triggers recovery
when an old unsent output is over 250 ms behind and the view is eligible for
dropping intermediate output. One recovery costs a full modeled RTT, and
the policy waits at least a second before another reset.

Example output (p95 observed age, milliseconds):

| Link               | Raw dashboard | Age-limited dashboard | Raw log (both policies) |
| ------------------ | ------------: | --------------------: | ----------------------: |
| LAN                |             0 |                     0 |                       0 |
| 100 ms WAN         |            50 |                    50 |                      50 |
| 512 kbit/s, 200 ms |         8,323 |                   404 |                  24,833 |
| 256 kbit/s, 400 ms |        18,463 |                   865 |                  26,783 |

The age policy skips 631 or 1,221 dashboard frames on the two constrained
links, respectively. Freshness comes at the expense of intermediate frames.
Raw log delivery is unchanged.

## Next transport experiment

Use the same unprivileged workload scripts and viewport for both endpoints.
Measure at least a prompt, compressible dashboard, scrolling output and random
full redraw. Use a sequence marker in the final cell of the frame and observe
both parsers **after application**, not just marker/header arrival. Timestamp
input and echo on the same client clock. Compare p50/p95 echo delay, p95 frame
age, paced FPS, actual bytes received, first prompt after reattach and
input/output ordering. Check control changes and resize during overload.
Include both local/no-loss and matched WAN/mobile RTT, rate and loss profiles.
Use an isolated shaping harness, not a user host's network settings. Keep
full output in the log workload and report loss/errors rather than discarding
failed runs. The portable fixtures here do not need network privileges.

## Candidate boundary for a first production change

Prefer an explicit replaceable-screen mode; never infer that arbitrary PTY
bytes are safe to drop. Add a monotonic creation time to internal output
records, check age before sending, and only request a fresh attachment if a
safe checkpoint is available and the peer negotiated the mode. Enforce a
per-session cooldown and suppress repeated resets until forward progress.
Do not reset input, back-date ACKs, or conflate a snapshot with full scrollback.
Keep recent raw sequence replay and legacy behavior unchanged when a
checkpoint is unavailable (e.g. incomplete VT sequence or alternate buffer).
Do not ship the model's constants until the transport experiment confirms them.

A rootless UDP relay is available for the transport experiment. Bind one
local test server and point one local client at a separate relay port:

```sh
python3 tools/terminal-bench/udp_relay.py --listen 9018 --server 9019 \
  --rtt-ms 200 --down-bps 512000 --loss 0.01 --seed 42
```

It binds only IPv4 loopback, applies nominal delay and independent
per-datagram loss in both directions, and serializes downstream payload
bytes at the supplied rate. It preserves the application's encryption and
does not work for a TCP path. Use separate local port pairs per case,
normal test certificates for QUIC/WebTransport, and do not treat this as an
identical replacement for kernel netem (timer precision, queue and protocol
overhead differ). A 500-byte UDP echo smoke test with 100 ms RTT and
80 kbit/s downstream returned unchanged in approximately 151 ms.

## Production transport fixture (Unix)

The opt-in Rust fixture starts the production host server with a temporary
configuration, database, generated test TLS certificate, and paired credential.
It binds loopback on an ephemeral port and launches only its own synthetic
Python raw-mode PTY. It does not connect to an installed daemon or personal
terminal, change trust stores, or alter host networking. The client pins the
fixture certificate using the library's test-client API.

```sh
pnpm install --frozen-lockfile
python3 tools/terminal-bench/run_transport.py --runs 5 --output /tmp/terminal-transport.json
```

This compiles the test in release mode and alternates local/no-loss and a
200 ms RTT, 512 kbit/s downstream/no-loss UDP relay profile. Each run authenticates,
creates a terminal, opens its attachment and ordered input stream, and measures
100 one-byte inputs through production RPC and the real PTY. Echo latency ends
after a complete output event is decoded and its marker is applied to a
`vt100` parser. The fixture also validates a 2 MiB scrolling burst by full byte count,
repeated-byte content and visible completion marker, checks contiguous raw
sequence numbers,
pauses application reads for 500 ms, measures drain time, and measures first
synthetic echo after attachment replacement and after new-connection/auth recovery.
The client receives and validates the entire raw burst; no intermediate shell
bytes are discarded to improve the measurements. The daemon still uses its
normal 1 MiB replay-retention budget.

This is **not browser/xterm rendering, a real interactive-shell prompt, or an
rsh comparison**. Drain includes client-side VT parsing and viewport inspection.
The read pause alone does not prove sender backpressure occurred. Decoded output
counts exclude CBOR, TLS, QUIC, UDP/IP overhead, ACKs, and retransmissions. The
relay is a rootless test approximation, not kernel netem. Results retain every
run's exit code and complete stdout, including failures. A failed run stops the
batch and is not replaced silently.

Normal completion closes the synthetic terminal, closes the connection, aborts
the isolated host task and reaps the relay. Errors also attempt terminal cleanup;
the synthetic PTY has a 180-second safety alarm. The test is ignored in normal
suites and registered only on Unix. It needs `python3` at `/usr/bin/python3`.
A single custom profile can be run with `RIEUL_BENCH_RTT_MS`,
`RIEUL_BENCH_DOWN_BPS`, and `RIEUL_BENCH_LOSS` before this command:

```sh
cargo test --release -p rieul-daemon-host --lib terminal_transport_measurement -- --ignored --nocapture
```

The stage timers separately report WebTransport connection establishment,
authentication response, attach response, explicit control response, local input
stream enqueue and input-to-applied-marker latency. Repeated helper stage keys
appear in cold-attach, same-connection reattach, new-connection reattach order.
The runner preserves every observation in `metric_samples`; `metrics` contains
the final observation for each key. QUIC counters cover the whole connection
interval, not terminal payload alone. Received UDP payload bytes exclude UDP/IP
headers. Received blocked-frame counts are protocol evidence, not proof that a
zero count means no backpressure. The reported QUIC RTT is a smoothed estimate
after the bulk transfer, not the nominal relay RTT.
