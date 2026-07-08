import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { visualizer } from "rollup-plugin-visualizer";
import UnoCSS from "unocss/vite";

const devAllowedHosts = readDevAllowedHosts();

export default defineConfig({
  plugins: [
    UnoCSS(),
    react(),
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
});

function readDevAllowedHosts(): string[] {
  const configUrl = new URL("../tmp/dev/rieul.yaml", import.meta.url);
  let yaml: string;
  try {
    yaml = Deno.readTextFileSync(configUrl);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }

  const domain = yaml.match(/^\s*domain:\s*["']?([^"'\s#]+)["']?/m)?.[1]
    ?.trim()
    .toLowerCase();
  return domain ? [domain] : [];
}
