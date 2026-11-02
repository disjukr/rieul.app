#!/usr/bin/env python3
"""Retry only the Apple ticket-transport failure observed in release CI.

All attempts and their diagnostics remain in the job log. This is not a
notarization or signature verifier: success still requires stapler exit zero,
and callers must retain their separate codesign/Gatekeeper checks.
"""
import argparse
import os
import re
import subprocess
import sys
import time

BACKOFF = (5, 15)  # Three attempts total; no workflow/job restart.
COMMAND_TIMEOUT = 120
TICKET_URL = "https://api.apple-cloudkit.com/database/1/com.apple.gk.ticket-delivery/production/public/records/lookup"


def retryable(result, action):
    output = result.stdout
    return (
        result.returncode == 68
        and re.search(r"Error Domain=NSURLErrorDomain Code=-1005(?=\s)", output) is not None
        and re.search(r"NSErrorFailingURL(?:String)?Key=" + re.escape(TICKET_URL) + r"(?=[,}\s]|$)", output) is not None
        and re.search(r"The " + (r"(?:staple and validate|staple)" if action == "staple" else "validate") + r" action failed! Error 68\.", output) is not None
        # Never retry an explicit semantic rejection, including mixed diagnostics.
        and re.search(r"invalid|revoked|tamper|not notarized|does not match", output, re.IGNORECASE) is None
    )


def run(action, path, *, execute=subprocess.run, sleep=time.sleep, output=sys.stderr):
    if action not in ("staple", "validate"):
        raise ValueError("unsupported stapler action")
    command = ["/usr/bin/xcrun", "stapler", action, os.path.abspath(path)]
    env = dict(os.environ, LC_ALL="C", LANG="C")
    for attempt in range(len(BACKOFF) + 1):
        print(f"stapler {action}: attempt {attempt + 1}/{len(BACKOFF) + 1}", file=output, flush=True)
        try:
            result = execute(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             text=True, errors="replace", timeout=COMMAND_TIMEOUT, env=env)
        except subprocess.TimeoutExpired as error:
            partial = error.stdout or ""
            if isinstance(partial, bytes):
                partial = partial.decode("utf-8", errors="replace")
            print(partial, file=output)
            print("stapler timed out; not classified as an Apple transport diagnostic", file=output, flush=True)
            return 124
        except OSError as error:
            print(f"Could not execute stapler: {error}", file=output, flush=True)
            return 127
        print(result.stdout, file=output, end="", flush=True)
        if result.returncode == 0:
            return 0
        if attempt == len(BACKOFF) or not retryable(result, action):
            return result.returncode if result.returncode > 0 else 1
        delay = BACKOFF[attempt]
        print(f"Confirmed Apple ticket connection loss (-1005); retrying in {delay}s", file=output, flush=True)
        sleep(delay)
    raise AssertionError("unreachable")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("staple", "validate"))
    parser.add_argument("path")
    args = parser.parse_args()
    sys.exit(run(args.action, args.path))
