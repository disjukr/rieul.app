import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./web/tests/ui",
  use: { baseURL: "http://127.0.0.1:5187", headless: true },
  webServer: {
    command:
      "pnpm --dir web exec vite --host 127.0.0.1 --port 5187 --strictPort",
    url: "http://127.0.0.1:5187",
    reuseExistingServer: false,
  },
});
