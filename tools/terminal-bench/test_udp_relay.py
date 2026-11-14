"""Verify the shaper on one isolated local UDP exchange."""
import socket
import subprocess
import sys
import time
import unittest
from pathlib import Path


class RelayTest(unittest.TestCase):
    def test_loopback_echo_delay_and_downstream_serialization(self):
        with (
            socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as server,
            socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as client,
        ):
            server.bind(("127.0.0.1", 0))
            server.settimeout(2)
            client.settimeout(2)
            relay = subprocess.Popen(
                [sys.executable, str(Path(__file__).with_name("udp_relay.py")),
                 "--listen", "0", "--server", str(server.getsockname()[1]),
                 "--rtt-ms", "100", "--down-bps", "80000"],
                stdout=subprocess.PIPE, text=True,
            )
            try:
                port = int(relay.stdout.readline().split()[-1])
                payload = b"x" * 500
                start = time.perf_counter()
                client.sendto(payload, ("127.0.0.1", port))
                data, addr = server.recvfrom(1024)
                self.assertEqual(data, payload)
                server.sendto(data, addr)
                self.assertEqual(client.recv(1024), payload)
                # 100 ms round trip + 50 ms serialization (tolerate clock jitter).
                self.assertGreaterEqual(time.perf_counter() - start, 0.14)
            finally:
                relay.terminate()
                relay.communicate(timeout=2)


if __name__ == "__main__":
    unittest.main()
