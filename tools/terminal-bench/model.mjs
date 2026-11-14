// Deterministic terminal-output scheduling model, not a QUIC benchmark.
const profiles = [
  ["lan", Infinity, 0],
  ["wan", Infinity, 100],
  ["mobile", 512_000, 200],
  ["badmobile", 256_000, 400],
  ["slow-observer", Infinity, 0, 25],
];
const workloads = [
  ["prompt", 2, 96, 96],
  ["dashboard", 60, 1_500, 1_500],
  ["log", 60, 8_192, null],
];
const durationMs = 30_000;
const targetAgeMs = 250;
const cooldownMs = 1_000;
const ix = (items, fraction) => items[Math.ceil(items.length * fraction) - 1] ?? null;

function run(profile, workload, latest) {
  const [, bitrate, rtt, observerMs = 0] = profile;
  const [, frequency, rawBytes, checkpointBytes] = workload;
  const n = durationMs * frequency / 1000;
  const produced = n => n * 1000 / frequency;
  let observerAvailable = 0;
  let available = 0, switchedAt = -Infinity, writes = 0, skips = 0, bytes = 0;
  const age = [];
  let firstAfterReconnect = null;
  for (let i = 0; i < n; i++) {
    let start = Math.max(available, produced(i), observerAvailable - rtt / 2);
    let payload = rawBytes;
    const fresh = Math.min(n - 1, Math.floor(start * frequency / 1000));
    if (latest && checkpointBytes !== null && fresh > i &&
        start - produced(i) > targetAgeMs && start - switchedAt >= cooldownMs) {
      // Model one reattach RTT. A checkpoint taken at server request arrival
      // replaces skipped *visual* output only; raw logs are never discarded.
      const checkpointAt = start + rtt / 2;
      const baseline = Math.min(n - 1, Math.floor(checkpointAt * frequency / 1000));
      skips += baseline - i;
      i = baseline;
      start = checkpointAt;
      switchedAt = start;
      payload = checkpointBytes;
      firstAfterReconnect ??= rtt + payload * 8 * 1000 / bitrate + observerMs;
    }
    available = start + payload * 8 * 1000 / bitrate;
    observerAvailable = available + rtt / 2 + observerMs;
    if (observerAvailable >= durationMs) break;
    writes++;
    bytes += payload;
    age.push(observerAvailable - produced(i));
  }
  age.sort((a, b) => a - b);
  return { writes, skips, bytes, p95AgeMs: Math.round(ix(age, .95) ?? 0),
    firstAfterReconnectMs: firstAfterReconnect === null ? null : Math.round(firstAfterReconnect) };
}

console.log("link workload policy writes skipped payload_bytes p95_age_ms modeled_recovery_ms");
for (const profile of profiles) for (const workload of workloads) {
  for (const latest of [false, true]) {
    const r = run(profile, workload, latest);
    console.log(profile[0], workload[0], latest ? "age" : "raw",
      r.writes, r.skips, r.bytes, r.p95AgeMs, r.firstAfterReconnectMs ?? "-");
  }
  if (workload[3] === null && JSON.stringify(run(profile, workload, false)) !==
      JSON.stringify(run(profile, workload, true))) throw Error("raw workload changed");
}
