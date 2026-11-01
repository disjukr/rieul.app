import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
export const execute = promisify(execFile);
export const root = fileURLToPath(new URL("..", import.meta.url));
export const sha256 = async (file) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
