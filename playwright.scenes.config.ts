// Scene tests (scripts/ux/scenes.pw.ts): recorded duel moments checked for UX rules, accessibility and their look.
// Screenshot baselines are per machine (fonts render differently per OS) and not committed: the first run
// creates them, later runs diff against them (report: playwright-report-scenes/, open it to see the diffs).
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "scripts/ux",
  testMatch: "scenes.pw.ts",
  timeout: 120_000,
  fullyParallel: true,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report-scenes" }]],
  outputDir: "test-results-scenes",
  snapshotPathTemplate: "scripts/ux/baselines/{arg}-{projectName}{ext}",
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:8788",
    browserName: "chromium",
    // a fixed look: default theme, no reduced motion, light scheme
    colorScheme: "light",
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1920, height: 1080 } } },
    { name: "laptop", use: { viewport: { width: 1366, height: 768 } } },
  ],
});
