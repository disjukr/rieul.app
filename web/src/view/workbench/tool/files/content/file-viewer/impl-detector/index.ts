import type { FileViewerImplId } from "../impl/index.ts";
import type { FsEntry } from "../../../../../../../protocol/generated/rpc.ts";
import { readFileBytes } from "../read-file-bytes.ts";
import type { Machine } from "../../../../../../../state/machines.ts";

const sampleByteCount = 4096;
const binaryControlRatioThreshold = 0.08;

interface DetectFileViewerImplResult {
  initialBytes: Uint8Array;
  impl: FileViewerImplId;
}

const binaryExtensions = new Set([
  "7z",
  "class",
  "dll",
  "dmg",
  "doc",
  "docx",
  "exe",
  "gz",
  "jar",
  "mov",
  "mp3",
  "mp4",
  "o",
  "obj",
  "ppt",
  "pptx",
  "rar",
  "wasm",
  "xls",
  "xlsx",
  "zip",
]);

const textExtensions = new Set([
  "bat",
  "c",
  "cmd",
  "cpp",
  "cs",
  "css",
  "csv",
  "env",
  "go",
  "h",
  "hpp",
  "html",
  "java",
  "js",
  "json",
  "jsx",
  "kt",
  "lock",
  "log",
  "mjs",
  "ps1",
  "py",
  "rs",
  "sh",
  "sql",
  "toml",
  "ts",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml",
]);

const markdownExtensions = new Set([
  "markdown",
  "md",
  "mdown",
  "mkd",
  "mkdn",
]);

const pdfExtensions = new Set([
  "pdf",
]);

const imageExtensions = new Set([
  "avif",
  "bmp",
  "gif",
  "ico",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "webp",
]);

const markdownFilenames = new Set([
  "readme",
]);

const textFilenames = new Set([
  ".editorconfig",
  ".env",
  ".gitattributes",
  ".gitignore",
  "dockerfile",
  "license",
  "makefile",
]);

export async function detectFileViewerImpl(
  machine: Machine | undefined,
  fsEntry: FsEntry,
  transport: WebTransport,
): Promise<DetectFileViewerImplResult> {
  const nameHint = detectFileViewerImplFromName(fsEntry);
  if (!machine) {
    return {
      initialBytes: new Uint8Array(),
      impl: nameHint ?? "text",
    };
  }

  try {
    const initialBytes = await readFileBytes(transport, fsEntry.path, {
      offset: 0,
      length: sampleByteCount,
    });
    return {
      initialBytes,
      impl: detectFileViewerImplFromBytes(initialBytes, nameHint),
    };
  } catch {
    return {
      initialBytes: new Uint8Array(),
      impl: nameHint ?? "text",
    };
  }
}

function detectFileViewerImplFromBytes(
  bytes: Uint8Array,
  nameHint: FileViewerImplId | undefined,
): FileViewerImplId {
  if (nameHint === "pdf") return "pdf";
  if (nameHint === "image" || hasImageSignature(bytes)) return "image";

  const sample = bytes.subarray(0, Math.min(bytes.length, sampleByteCount));
  if (sample.includes(0)) return "hex";

  let controls = 0;
  for (const byte of sample) {
    const isTextControl = byte === 9 || byte === 10 || byte === 13;
    if (byte < 32 && !isTextControl) controls++;
  }
  return sample.length > 0 &&
      controls / sample.length > binaryControlRatioThreshold
    ? "hex"
    : nameHint ?? "text";
}

function detectFileViewerImplFromName(
  fsEntry: FsEntry,
): FileViewerImplId | undefined {
  const basename = fileBasename(fsEntry.name || fsEntry.path).toLowerCase();
  if (markdownFilenames.has(basename)) return "markdown";
  if (textFilenames.has(basename)) return "text";

  const extension = fileExtension(basename);
  if (!extension) return undefined;
  if (markdownExtensions.has(extension)) return "markdown";
  if (pdfExtensions.has(extension)) return "pdf";
  if (imageExtensions.has(extension)) return "image";
  if (binaryExtensions.has(extension)) return "hex";
  if (textExtensions.has(extension)) return "text";
  return undefined;
}

function fileBasename(name: string): string {
  const normalized = name.trim().replace(/[\\/]+$/g, "");
  const slashIndex = Math.max(
    normalized.lastIndexOf("/"),
    normalized.lastIndexOf("\\"),
  );
  return normalized.slice(slashIndex + 1);
}

function fileExtension(basename: string): string | undefined {
  const dotIndex = basename.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === basename.length - 1) return undefined;
  return basename.slice(dotIndex + 1).toLowerCase();
}

function hasImageSignature(bytes: Uint8Array): boolean {
  if (bytes.length >= 8 && startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) {
    return true;
  }
  if (bytes.length >= 3 && startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return true;
  }
  if (
    bytes.length >= 6 &&
    (startsWithAscii(bytes, "GIF87a") || startsWithAscii(bytes, "GIF89a"))
  ) {
    return true;
  }
  if (
    bytes.length >= 12 &&
    startsWithAscii(bytes, "RIFF") &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return true;
  }
  if (bytes.length >= 2 && startsWithAscii(bytes, "BM")) return true;
  if (bytes.length >= 4 && startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) {
    return true;
  }
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70 &&
    bytes[8] === 0x61 &&
    bytes[9] === 0x76 &&
    bytes[10] === 0x69 &&
    bytes[11] === 0x66
  ) {
    return true;
  }
  return false;
}

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((byte, index) => bytes[index] === byte);
}

function startsWithAscii(bytes: Uint8Array, prefix: string): boolean {
  if (bytes.length < prefix.length) return false;
  for (let index = 0; index < prefix.length; index++) {
    if (bytes[index] !== prefix.charCodeAt(index)) return false;
  }
  return true;
}
