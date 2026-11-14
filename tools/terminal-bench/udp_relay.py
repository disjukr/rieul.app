"""Rootless loopback UDP impairment for one test client and one local server."""
import argparse
import asyncio
import random


class Link(asyncio.DatagramProtocol):
    def __init__(self, loop, server, rtt_ms, down_bps, loss, seed):
        self.loop = loop
        self.server = server
        self.client = None
        self.delay = rtt_ms / 2000
        self.down_bps = down_bps
        self.loss = loss
        self.random = random.Random(seed)
        self.available = 0.0
        self.pending = 0

    def connection_made(self, transport):
        self.transport = transport

    def send(self, data, target):
        self.pending -= 1
        self.transport.sendto(data, target)

    def datagram_received(self, data, origin):
        down = origin == self.server
        if down:
            target = self.client
            if target is None:
                return
        else:
            if self.client is not None and origin != self.client:
                return
            self.client = origin
            target = self.server
        if self.pending >= 4096 or self.random.random() < self.loss:
            return
        now = self.loop.time()
        when = now + self.delay
        if down and self.down_bps:
            self.available = max(now, self.available) + len(data) * 8 / self.down_bps
            when = self.available + self.delay
        self.pending += 1
        self.loop.call_at(when, self.send, data, target)


async def run(args):
    loop = asyncio.get_running_loop()
    transport, _ = await loop.create_datagram_endpoint(
        lambda: Link(loop, ("127.0.0.1", args.server), args.rtt_ms,
                     args.down_bps, args.loss, args.seed),
        local_addr=("127.0.0.1", args.listen),
    )
    try:
        print(f"Relay listening on {transport.get_extra_info('sockname')[1]}", flush=True)
        await asyncio.Future()
    finally:
        transport.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--listen", required=True, type=int)
    parser.add_argument("--server", required=True, type=int)
    parser.add_argument("--rtt-ms", default=0, type=float)
    parser.add_argument("--down-bps", default=0, type=int)
    parser.add_argument("--loss", default=0, type=float, help="per-datagram probability 0..1")
    parser.add_argument("--seed", default=1, type=int)
    args = parser.parse_args()
    if not 0 <= args.listen < 65536 or not 0 < args.server < 65536 or args.listen == args.server:
        parser.error("requires distinct loopback ports (listen=0 selects an ephemeral port)")
    if not 0 <= args.rtt_ms <= 10_000 or args.down_bps < 0 or not 0 <= args.loss < 1:
        parser.error("invalid link parameters")
    try:
        asyncio.run(run(args))
    except KeyboardInterrupt:
        pass
