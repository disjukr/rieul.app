import net from "node:net";
import { unlink, lstat } from "node:fs/promises";
import * as wire from "../../web/src/protocol/socket-ipc.ts";
import { decodeCborSequence } from "../../web/src/protocol/cbor.ts";
import type { PairingController } from "./controller.ts";

export async function activateExisting(endpoint: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint);
    const chunks: Buffer[] = [];
    let settled = false;
    let received = 0;
    const timer = setTimeout(
      () => finish(new Error("GUI activation timed out")),
      5000,
    );
    const finish = (error?: Error, exists = true) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(exists);
    };
    socket.once("connect", () =>
      socket.end(
        wire.encodeSocketUnaryRequest(
          1,
          wire.IPC_PROC_ACTIVATE_GUI,
          wire.encodeActivateGuiReq("already-running"),
        ),
      ),
    );
    socket.on("data", (chunk) => {
      received += chunk.length;
      if (received > 64 * 1024)
        return finish(new Error("GUI activation response too large"));
      chunks.push(chunk);
    });
    socket.once("end", () => {
      try {
        const items = decodeCborSequence(Buffer.concat(chunks));
        if (
          items.length !== 4 ||
          items[0] !== 3 ||
          items[2] !== 101 ||
          !(items[1] instanceof Map) ||
          items[1].get(100) !== 1 ||
          !(items[3] instanceof Map) ||
          items[3].get(100) !== 1
        )
          throw new Error("GUI activation returned an invalid response");
        finish();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once("close", () => {
      if (!settled)
        finish(new Error("GUI activation connection closed before response"));
    });
    socket.once("error", (error: NodeJS.ErrnoException) =>
      ["ENOENT", "ECONNREFUSED"].includes(error.code ?? "")
        ? finish(undefined, false)
        : finish(error),
    );
  });
}

/** Binds before creating a GPU window, preventing duplicate windows/trays. */
export async function startIpc(
  endpoint: string,
  controller: PairingController,
) {
  const sockets = new Set<net.Socket>();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.setTimeout(5000, () => socket.destroy());
    const abort = new AbortController();
    socket.on("error", () => {});
    socket.once("close", () => {
      sockets.delete(socket);
      abort.abort();
    });
    let buffer = Buffer.alloc(0),
      handled = false,
      confirmation = false;
    socket.on("data", (chunk) => {
      if (handled) return;
      try {
        if (buffer.length + chunk.length > 64 * 1024 * 1024)
          throw new Error("IPC request too large");
        buffer = Buffer.concat([buffer, chunk]);
        const request = wire.decodeSocketUnaryRequestPrefix(buffer);
        if (!request) return;
        handled = true;
        socket.setTimeout(0);
        confirmation = request.procId === wire.IPC_PROC_CONFIRM_PAIRING;
        buffer = Buffer.alloc(0);
        void controller.request(request, abort.signal).then(
          (payload) => {
            if (!socket.destroyed)
              socket.end(
                wire.encodeSocketUnaryOkResponse(request.streamId, payload),
              );
          },
          (error) => {
            if (!socket.destroyed)
              socket.end(
                wire.encodeSocketUnaryErrorResponse(
                  request.streamId,
                  String(error),
                ),
              );
          },
        );
      } catch {
        socket.destroy();
      }
    });
    socket.once("end", () => {
      if (!handled) socket.destroy();
      else if (confirmation) abort.abort();
    });
  });
  const listen = () =>
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint, () => {
        server.off("error", reject);
        resolve();
      });
    });
  try {
    await listen();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    if (await activateExisting(endpoint)) return undefined;
    if (process.platform !== "darwin") throw error;
    // Only remove a stale socket owned by this user, never arbitrary files.
    const stat = await lstat(endpoint);
    if (!stat.isSocket() || stat.uid !== process.getuid?.()) throw error;
    await unlink(endpoint);
    await listen();
  }
  let disposal: Promise<void> | undefined;
  return {
    dispose() {
      return (disposal ??= (async () => {
        controller.dispose();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      })());
    },
  };
}
