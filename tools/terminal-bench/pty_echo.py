"""Measure local kernel PTY line-discipline echo (not Rieul/rsh or shell latency)."""

import argparse
import os
import pty
import select
import termios
import time
import tty


def collect(count):
    master, slave = pty.openpty()
    samples = []
    try:
        tty.setraw(slave)
        attrs = termios.tcgetattr(slave)
        attrs[3] |= termios.ECHO
        termios.tcsetattr(slave, termios.TCSANOW, attrs)
        for _ in range(count):
            start = time.perf_counter_ns()
            os.write(master, b"x")
            if not select.select([master], [], [], 1)[0]:
                raise TimeoutError("PTY echo did not arrive")
            if os.read(master, 16) != b"x":
                raise ValueError("unexpected PTY echo")
            samples.append((time.perf_counter_ns() - start) / 1000)
    finally:
        os.close(master)
        os.close(slave)
    return sorted(samples)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", default=1000, type=int)
    args = parser.parse_args()
    if args.samples < 1:
        parser.error("--samples must be positive")
    samples = collect(args.samples)
    print(f"samples={len(samples)} local_pty_echo_p50_us={samples[len(samples) // 2]:.3f}"
          f" p95_us={samples[(95 * len(samples) + 99) // 100 - 1]:.3f}")
