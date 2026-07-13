import {
  desktopConfigPathFromUrl,
  withDesktopConfigPath,
} from "../src/desktop-context.ts";

function assertEquals(actual: unknown, expected: unknown) {
  if (actual !== expected) {
    throw new Error(`expected ${String(expected)}, received ${String(actual)}`);
  }
}

Deno.test("desktop config path survives URL encoding", () => {
  const configPath = String.raw`C:\ProgramData\Rieul\rieul.yaml`;
  const url = withDesktopConfigPath(
    "http://127.0.0.1:5179/daemon-main.html?dev=true#main",
    configPath,
  );

  assertEquals(desktopConfigPathFromUrl(url), configPath);
  assertEquals(new URL(url).searchParams.get("dev"), "true");
  assertEquals(new URL(url).hash, "#main");
});

Deno.test("missing desktop config path remains unavailable", () => {
  assertEquals(
    desktopConfigPathFromUrl("http://127.0.0.1:5179/daemon-main.html"),
    undefined,
  );
});
