import { defineConfig } from "vite";
import solid from "@solidjs/vite-plugin";
export default defineConfig({
  plugins: [solid()],
  build: { rolldownOptions: { input: ["index.html", "production.html"] } },
  resolve: {
    dedupe: ["bunja", "jotai", "unsaturated", "solid-js", "@solidjs/web"],
  },
  server: { host: "127.0.0.1", port: 5191, strictPort: true },
});
