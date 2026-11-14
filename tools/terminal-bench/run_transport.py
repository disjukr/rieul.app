"""Run opt-in production transport fixtures and retain every run, including errors."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--runs", type=int, default=5)
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
if args.runs < 1:
    parser.error("--runs must be positive")
root = Path(__file__).resolve().parents[2]
command = ["cargo", "test", "--release", "-p", "rieul-daemon-host", "--lib",
           "terminal_transport_measurement", "--", "--ignored", "--nocapture"]
subprocess.run(command[:7] + ["--no-run"], cwd=root, check=True)
profiles = [("local", "0", "0"), ("wan_200ms_512k", "200", "512000")]
records = []
args.output.parent.mkdir(parents=True, exist_ok=True)
for repeat in range(args.runs):
    for name, rtt, rate in profiles:
        env = dict(os.environ, RIEUL_BENCH_RTT_MS=rtt,
                   RIEUL_BENCH_DOWN_BPS=rate, RIEUL_BENCH_LOSS="0")
        start = time.time()
        run = subprocess.run(command, cwd=root, env=env, text=True,
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        metric_samples = {}
        for key, value in re.findall(r"([a-z][a-z0-9_]*)=([0-9.]+)", run.stdout):
            metric_samples.setdefault(key, []).append(float(value))
        record = {"profile": name, "repeat": repeat + 1, "started_unix": start,
                  "exit_code": run.returncode, "stdout": run.stdout,
                  "metrics": {key: values[-1] for key, values in metric_samples.items()},
                  "metric_samples": metric_samples}
        records.append(record)
        args.output.write_text(json.dumps(records, indent=2) + "\n")
        print(json.dumps({k: v for k, v in record.items() if k != "stdout"}), flush=True)
        if run.returncode:
            raise SystemExit(f"failed run retained in {args.output}")
