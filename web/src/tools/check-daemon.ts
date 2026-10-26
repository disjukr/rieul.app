import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

interface Args {
  url?: string;
  config: string;
  timeoutMs: number;
}

const args = parseArgs(
  process.argv.slice(2)[0] === "--"
    ? process.argv.slice(2).slice(1)
    : process.argv.slice(2),
);
const configTls = await readConfigTls(args.config);
if (!configTls.trustedTls) {
  throw new Error(
    `${args.config} must configure tls or a .ts.net domain; self-signed hash pinning is not supported`,
  );
}
const baseUrl = args.url ?? configTls.defaultUrl;

const rpcUrl = rpcEndpoint(baseUrl);

console.log(`connecting ${rpcUrl} with Chromium WebTransport`);
await checkWebTransport(rpcUrl, args.timeoutMs);
console.log("connected");

function parseArgs(argv: string[]): Args {
  const args: Args = {
    config: fileURLToPath(
      new URL("../../../tmp/dev/rieul.yaml", import.meta.url),
    ),
    timeoutMs: 10_000,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--url") args.url = requireValue(argv, ++i, arg);
    else if (arg === "--config") args.config = requireValue(argv, ++i, arg);
    else if (arg === "--timeout-ms") {
      args.timeoutMs = Number(requireValue(argv, ++i, arg));
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  pnpm check:daemon
  pnpm exec tsx src/tools/check-daemon.ts [--url https://localhost:9019] [--config ../tmp/dev/rieul.yaml]
`);
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

async function readConfigTls(
  configPath: string,
): Promise<{ trustedTls: boolean; defaultUrl: string }> {
  const yaml = await readFile(configPath, "utf8");
  const domain = yaml
    .match(/^\s*domain:\s*["']?([^"'\s#]+)["']?/m)?.[1]
    ?.trim()
    .toLowerCase();
  const port = configListenPort(yaml);
  const trustedTls =
    /^\s*tls:\s*$/m.test(yaml) || !!domain?.endsWith(".ts.net");
  return {
    trustedTls,
    defaultUrl: domain ? daemonUrl(domain, port) : `https://localhost:${port}`,
  };
}

function configListenPort(yaml: string): number {
  const rawListenAddr = yaml
    .match(/^\s*listenAddr:\s*["']?([^"'\s#]+)["']?/m)?.[1]
    ?.trim();
  if (!rawListenAddr) return 9012;
  const port = Number(rawListenAddr.split(":").at(-1));
  if (Number.isSafeInteger(port) && port > 0 && port <= 65535) return port;
  return 9012;
}

function daemonUrl(host: string, port: number): string {
  if (port === 443) return `https://${host}`;
  return `https://${host}:${port}`;
}

function rpcEndpoint(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:") {
    throw new Error("WebTransport URL must use https");
  }
  if (url.pathname === "/" || url.pathname === "") url.pathname = "/rieul/rpc";
  return url.toString();
}

async function checkWebTransport(
  url: string,
  timeoutMs: number,
): Promise<void> {
  // Node does not provide WebTransport. Probe with the same browser API used
  // by the app, without changing certificate validation or persistent profiles.
  const server = createServer((_request, response) =>
    response.end("<!doctype html><title>Rieul transport probe</title>"),
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing probe listener");
    await page.goto(`http://127.0.0.1:${address.port}`);
    await withTimeout(
      page.evaluate(async (url) => {
        const transport = new WebTransport(url);
        try {
          await transport.ready;
        } finally {
          transport.close({ closeCode: 0, reason: "done" });
        }
      }, url),
      "WebTransport ready",
      timeoutMs,
    );
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
