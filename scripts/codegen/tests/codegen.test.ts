import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  findBdlConfigPath,
  getResolveModuleFileFn,
  loadBdlConfig,
} from "../bdl-config.ts";
const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));
async function temporary(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "rieul-codegen-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
async function generate(language: string, args: string[]) {
  await exec(
    process.execPath,
    ["--import", "tsx", `scripts/codegen/${language}/main.ts`, ...args],
    { cwd: root },
  );
}

test("Node TypeScript codegen matches the checked-in wire/RPC/client byte for byte", async () =>
  temporary(async (directory) => {
    const wire = join(directory, "wire.ts"),
      rpc = join(directory, "rpc.ts"),
      client = join(directory, "client.ts");
    await generate("typescript", [
      "--standard",
      "wire",
      "--schema",
      "protocol/schemas/wire",
      "--out",
      wire,
      "--cbor-import",
      "../cbor.ts",
    ]);
    await generate("typescript", [
      "--standard",
      "rpc",
      "--schema",
      "protocol/schemas/rpc",
      "--out",
      rpc,
      "--rpc-client-out",
      client,
      "--cbor-import",
      "../cbor.ts",
      "--generated-import",
      "./rpc.ts",
      "--rpc-runtime-import",
      "../client.ts",
    ]);
    for (const file of ["wire.ts", "rpc.ts", "client.ts"])
      assert.deepEqual(
        await readFile(join(directory, file)),
        await readFile(join(root, "web/src/protocol/generated", file)),
      );
  }));

// Captured from unmodified 50827d2 using its original 0.8.3 codegen on Windows.
// Keep these compatibility goldens independent from the Node generator under test.
const rustBaseline = {
  wire: "ef71c3825e1750fea98e7734423be01aec84aa0642765c7fe05d9388c1befd1a",
  "socket-wire":
    "72af8be28ae16e56d51180ab97c92e6884d7f25a810570e02e7bacf8b3b61109",
  rpc: "c537a4a668a566d9fc14cd728695aed69188152ff263d59be8829ebd71e9509a",
  ipc: "02ab284ae877404a3b2650ca21c6efa402d0372d74593b21b2a4295a5c65172a",
};
for (const [schema, hash] of Object.entries(rustBaseline))
  test(`Node Rust codegen preserves ${schema} baseline and is deterministic`, async () =>
    temporary(async (directory) => {
      const output = join(directory, `${schema}.rs`);
      const args = [
        "--schema",
        `protocol/schemas/${schema}`,
        "--out",
        output,
        ...(["wire", "socket-wire"].includes(schema)
          ? ["--no-byte-codec"]
          : []),
      ];
      await generate("rust", args);
      const first = await readFile(output);
      assert.equal(createHash("sha256").update(first).digest("hex"), hash);
      await generate("rust", args);
      assert.deepEqual(await readFile(output), first);
    }));

test("Node BDL loader preserves ancestor and yml precedence plus encoded file URLs", async () =>
  temporary(async (directory) => {
    const nested = join(directory, "nested", "child");
    await mkdir(nested, { recursive: true });
    await writeFile(
      join(directory, "bdl.yaml"),
      "paths:\n  example: ./schemas\n",
    );
    assert.equal(await findBdlConfigPath(nested), join(directory, "bdl.yaml"));
    await writeFile(
      join(dirname(nested), "bdl.yaml"),
      "paths:\n  example: ./wrong\n",
    );
    await writeFile(
      join(dirname(nested), "bdl.yml"),
      "paths:\n  example: './schemas # space'\n",
    );
    const configPath = await findBdlConfigPath(nested);
    assert.equal(configPath, join(dirname(nested), "bdl.yml"));
    const { bdlConfig, configDirectory } = await loadBdlConfig(configPath);
    const source = join(configDirectory, "schemas # space", "message.bdl");
    await mkdir(dirname(source), { recursive: true });
    await writeFile(source, "struct Message {}\n");
    const resolved = await getResolveModuleFileFn(
      bdlConfig,
      configDirectory,
    )("example.message");
    assert.equal(resolved?.fileUrl, pathToFileURL(source).href);
    assert.equal(resolved?.text, "struct Message {}\n");
  }));
