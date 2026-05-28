const args = parseArgs(Deno.args);
const listen = args.listen ?? Deno.env.get("LISTEN") ?? "0.0.0.0:8765";
const domain = args.domain ?? Deno.env.get("DOMAIN") ?? "";
const force = args.force || Deno.env.get("FORCE") === "1";

const repoRoot = new URL("..", import.meta.url);
const tmpDir = new URL("tmp/dev/", repoRoot);
const logDir = new URL("tmp/log/", repoRoot);
const configUrl = new URL("system-wgo.yaml", tmpDir);
const configPath = configUrl.pathname;

await Deno.mkdir(tmpDir, { recursive: true });
await Deno.mkdir(logDir, { recursive: true });

if (!force && await exists(configUrl)) {
  console.log(`Dev config already exists: ${configPath}`);
  console.log("Use --force or FORCE=1 to overwrite it.");
  Deno.exit(0);
}

await Deno.writeTextFile(
  configUrl,
  [
    "# Tailscale dev config.",
    "# Set domain to this machine's Tailscale hostname, for example:",
    "# domain: my-machine.example-tailnet.ts.net",
    `listenAddr: "${listen}"`,
    `domain: "${domain}"`,
    "clients: []",
    "",
  ].join("\n"),
);

console.log(`Wrote dev config: ${configPath}`);
if (domain.trim() === "") {
  console.log("Edit domain before starting the daemon.");
} else {
  console.log(`Tailscale domain: ${domain}`);
}

function parseArgs(values: string[]): {
  domain?: string;
  listen?: string;
  force: boolean;
} {
  const parsed: { domain?: string; listen?: string; force: boolean } = {
    force: false,
  };

  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--force" || value === "-f") {
      parsed.force = true;
    } else if (value === "--domain" || value === "-d") {
      parsed.domain = requireValue(values, index, value);
      index += 1;
    } else if (value.startsWith("--domain=")) {
      parsed.domain = value.slice("--domain=".length);
    } else if (value === "--listen" || value === "-l") {
      parsed.listen = requireValue(values, index, value);
      index += 1;
    } else if (value.startsWith("--listen=")) {
      parsed.listen = value.slice("--listen=".length);
    } else if (!value.startsWith("-") && parsed.domain === undefined) {
      parsed.domain = value;
    } else {
      throw new Error(`unknown argument: ${value}`);
    }
  }

  return parsed;
}

function requireValue(values: string[], index: number, flag: string): string {
  const value = values[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

async function exists(path: URL): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return false;
    }
    throw err;
  }
}
