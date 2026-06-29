import { readFile } from "../../../../../../protocol/generated/client.ts";
import type {
  ReadFileChunk,
  ReadFileReq,
} from "../../../../../../protocol/generated/rpc.ts";

export async function readFileBytes(
  transport: WebTransport,
  path: string,
  options: Omit<ReadFileReq, "path"> = {},
): Promise<Uint8Array> {
  const chunks: ReadFileChunk[] = [];
  for await (
    const chunk of readFile(transport, {
      path,
      offset: options.offset,
      length: options.length,
    })
  ) {
    chunks.push(chunk);
  }
  return assembleReadFileChunks(chunks, options.offset ?? 0);
}

function assembleReadFileChunks(
  chunks: ReadFileChunk[],
  fallbackOffset: number,
): Uint8Array {
  if (chunks.length === 0) return new Uint8Array();
  const baseOffset = chunks[0]?.offset ?? fallbackOffset;
  const total = chunks.reduce((max, chunk) => {
    const end = chunk.offset - baseOffset + chunk.bytes.length;
    return Math.max(max, end);
  }, 0);
  const out = new Uint8Array(total);
  for (const chunk of chunks) {
    out.set(chunk.bytes, chunk.offset - baseOffset);
  }
  return out;
}
