# Terminal transport baseline, 2026-11-14

No performance improvement or rsh parity is claimed. This is a measured baseline
of Rieul's production host transport with a synthetic client and PTY. No
production protocol or scheduling behavior changed.

## Setup and validation

- Base source was `75c281929b8a9563266e080251ed56cc6c880acd` plus this fixture.
- Linux cloud container, nine reported logical cores, Rust 1.100.0, Python 3.12.14.
- Release build. Five alternating runs per profile. Each run measures 100
  sequential single-byte inputs, for 500 echo observations per profile.
- The real host serves TLS/WebTransport, paired authentication, terminal creation,
  attachment, explicit control acquisition, ordered streaming input and a real
  raw-mode Python PTY. The client fully decodes events and applies their bytes to
  a `vt100` parser before observing the marker.
- Each run validates all 2,097,152 repeated payload bytes, total decoded output
  length including the final marker, and contiguous output sequences. All ten
  repeated runs passed. No failed measured run was discarded or replaced.
- The rootless relay uses a fixed seed. No host network settings or installed
  daemon were changed. Both profiles used zero injected loss.

## Results

The table reports the median of five per-run results, followed by the observed
minimum and maximum. Units are milliseconds. Echo p50/p95 use the fixture's
upper empirical quantile, indexed by `ceil((n - 1) * p)`.

| Measurement                                     |                  Local |  200 ms RTT, 512 kbit/s downstream |
| ----------------------------------------------- | ---------------------: | ---------------------------------: |
| Echo p50                                        |    0.272 (0.217–0.324) |          203.473 (203.292–203.630) |
| Echo p95                                        |    0.511 (0.338–0.640) |          205.987 (205.261–236.393) |
| 2 MiB drain after 500 ms read pause             | 31.057 (27.186–33.515) | 33,422.295 (33,394.012–33,433.798) |
| Same-connection reattach to first echo          |    1.307 (0.974–1.747) |          618.340 (618.074–620.080) |
| New connection, auth and reattach to first echo |    2.965 (2.759–3.413) |    1,559.673 (1,556.686–1,570.962) |

The constrained bulk workload is consistent with the imposed rate limit.
Sending 2 MiB alone at 512,000 bit/s takes at least 32.768 seconds. The observed
completion includes protocol overhead and transport scheduling, less the 500 ms
already elapsed before timing the drain. Local observer work is included, but
is small relative to the roughly 33-second constrained drain. This is not a
claim that the local measurement is a performance ceiling.

The repeated rows are in `transport-baseline.json`. The runnable script retains
complete stdout and exit codes when producing new result files.

## Boundaries

This does not measure browser/xterm rendering, actual shell-prompt readiness,
frontend reconnect backoff, packet loss, dashboard redraw freshness, concurrent
clients or control/resize races. The first response after recovery is an
explicit synthetic echo. The read pause alone is not proof that QUIC flow
control blocked the sender. Decoded terminal payload bytes are not wire bytes.
Do not compare these numbers with published rsh measurements that use different
workloads and observer paths. The rsh reference was not executed or reused.

## Next experiment

Investigate the serialized control round trip only after inspecting the timing
stages. An optional, explicitly requested attach-and-take-control operation may
remove one WAN round trip without discarding output. It must preserve paired
authentication, attachment ownership, input epochs, resize failure semantics,
observer behavior and fallback to the existing explicit control RPC when the
peer does not support the option. Merely attaching must never take control.
This is a candidate, not an implemented or measured improvement.

## Separate stage inspection

One additional release run per profile used the same workload with stage timers
and QUIC counters. This is diagnostic evidence, not a repeated before/after
comparison. The constrained new-connection path measured 695.310 ms to establish
WebTransport, 223.656 ms for authentication, 232.109 ms for attachment,
203.453 ms for explicit control, 0.021 ms to enqueue the input stream start,
and 202.984 ms from input to the applied echo marker. Their sum explains the
1,557.632 ms total. The separate control response is therefore a measured roughly
one-RTT serialization cost, not an inferred CPU bottleneck.

The constrained transfer received 2,153,733 bytes inside UDP datagrams during the
bulk interval. At the configured rate, those bytes alone require 33.652 seconds.
The observed drain was 33.405 seconds after the 500 ms pause, consistent with
serialization plus the remaining network/scheduling time. Both received
flow-control-blocked frame counters were zero. Sender backpressure is therefore
not claimed from this diagnostic. The QUIC smoothed RTT after bulk was 6,304 ms,
which includes queueing history and must not be read as the nominal 200 ms link
RTT. Raw stage observations are in `transport-stages.json`.
