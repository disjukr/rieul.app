import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests",
  use: { baseURL: "http://127.0.0.1:5191", headless: true },
  webServer: {
    command: "pnpm exec vite",
    url: "http://127.0.0.1:5191",
    reuseExistingServer: false,
  },
});
