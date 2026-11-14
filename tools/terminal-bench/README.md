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

| Link | Raw dashboard | Age-limited dashboard | Raw log (both policies) |
| --- | ---: | ---: | ---: |
| LAN | 0 | 0 | 0 |
| 100 ms WAN | 50 | 50 | 50 |
| 512 kbit/s, 200 ms | 8,323 | 404 | 24,833 |
| 256 kbit/s, 400 ms | 18,463 | 865 | 26,783 |

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
