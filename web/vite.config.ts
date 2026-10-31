import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import solid from "@solidjs/vite-plugin";
import { visualizer } from "rollup-plugin-visualizer";
import UnoCSS from "unocss/vite";
import { resolve } from "node:path";

const devAllowedHosts = readDevAllowedHosts();

export default defineConfig({
  plugins: [
    UnoCSS(),
    solid(),
    {
      name: "verify-react-free-runtime",
      generateBundle() {
        const reactModules = [...this.getModuleIds()].filter((id) =>
          /[/\\]node_modules[/\\](?:\.pnpm[/\\][^/\\]+[/\\]node_modules[/\\])?(?:react|react-dom)(?:[/\\]|$)/.test(
            id,
          ),
        );
        if (reactModules.length)
          this.error(
            `React runtime remains in the Solid build:\n${reactModules.join("\n")}`,
          );
      },
    },
    visualizer({
      filename: "dist/bundle-stats.html",
      gzipSize: true,
      brotliSize: true,
      template: "flamegraph",
    }),
  ],
  server: {
    allowedHosts: devAllowedHosts,
    port: 5173,
  },
  build: {
    rolldownOptions: {
      input: {
        app: resolve(import.meta.dirname, "index.html"),
      },
    },
  },
});

function readDevAllowedHosts(): string[] {
  const configUrl = new URL("../tmp/dev/rieul.yaml", import.meta.url);
  let yaml: string;
  try {
    yaml = readFileSync(configUrl, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const domain = yaml
    .match(/^\s*domain:\s*["']?([^"'\s#]+)["']?/m)?.[1]
    ?.trim()
    .toLowerCase();
  return domain ? [domain] : [];
}
