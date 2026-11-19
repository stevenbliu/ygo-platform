// CPU-profiles a demo duel: where main-thread time goes (self time per function), and what runs inside long tasks
// (inclusive). Use it when the audit's long-task findings point at the React scheduler and you need the component.
// Writes ux-report/duel.cpuprofile (open in Chrome DevTools > Performance). Build with UX_SOURCEMAP=1 so
// DevTools can show source files.
//
//   node scripts/ux/profile.mjs [secs=30] [--base http://localhost:8788]
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { sourceAt } from "./sourcemap.mjs";
const bi = process.argv.indexOf("--base");
const BASE = bi > 0 ? process.argv[bi + 1] : "http://localhost:8788";
const SECS = Number(process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : 30), OUT = "ux-report";
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.addInitScript(() => {
  window.__lt = [];
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push([e.startTime, e.duration]); }).observe({ type: "longtask" }); } catch { /* */ }
});
await page.goto(`${BASE}/lobby`);
const name = page.getByPlaceholder(/e\.g\./i);
await name.or(page.getByText(/Dueling as/)).first().waitFor({ timeout: 20000 });
if (await name.isVisible()) { await name.fill("prof"); await page.getByRole("button", { name: /Continue as guest/ }).click(); await page.getByText(/Dueling as/).waitFor(); }
await page.getByRole("button", { name: /Watch a demo duel/ }).click();
await page.locator(".duel-field").waitFor({ timeout: 30000 });
const cdp = await page.context().newCDPSession(page);
await cdp.send("Profiler.enable");
await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
const t0 = await page.evaluate(() => performance.now());
await cdp.send("Profiler.start");
await page.waitForTimeout(SECS * 1000);
const { profile } = await cdp.send("Profiler.stop");
const lts = await page.evaluate((t) => window.__lt.filter(([s]) => s >= t), t0);
writeFileSync(`${OUT}/duel.cpuprofile`, JSON.stringify(profile));
// self time per node (named by source file:line when the build has maps)
const names = new Map();
const frameName = (n) => {
  const f = n.callFrame, k = `${f.url}:${f.lineNumber}:${f.columnNumber}:${f.functionName}`;
  if (!names.has(k)) names.set(k, (f.url.includes("/assets/") && f.lineNumber >= 0 && sourceAt(f.url, f.lineNumber + 1, f.columnNumber)) || `${f.functionName || "(anon)"} ${f.url.split("/").pop()}:${f.lineNumber}`);
  return names.get(k);
};
const byId = new Map(profile.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const self = new Map();
const deltas = profile.timeDeltas;
let t = profile.startTime;
const inLong = new Map();
const ltRanges = lts.map(([s, d]) => [s, s + d]);
// profile times are in microseconds since an arbitrary origin; align with performance.now via the first sample
const origin = profile.startTime / 1000 - t0;
for (let i = 0; i < profile.samples.length; i++) {
  t += deltas[i];
  const n = byId.get(profile.samples[i]);
  const key = frameName(n);
  const dt = (deltas[i + 1] ?? 0) / 1000;
  self.set(key, (self.get(key) ?? 0) + dt);
  const ms = t / 1000 - origin;
  if (ltRanges.some(([a, b]) => ms >= a && ms <= b)) {
    // attribute to the whole stack (inclusive) inside long tasks
    let id = n.id; const seen = new Set();
    while (id) { const m = byId.get(id); const k = frameName(m); if (!seen.has(k)) { inLong.set(k, (inLong.get(k) ?? 0) + dt); seen.add(k); } id = parent.get(id); }
  }
}
const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${v.toFixed(0).padStart(6)} ms  ${k}`).join("\n");
console.log(`long tasks: ${lts.length}, total ${lts.reduce((s, [, d]) => s + d, 0).toFixed(0)} ms, max ${Math.max(0, ...lts.map(([, d]) => d)).toFixed(0)} ms`);
console.log("\n-- self time (all) --\n" + top(self, 25));
console.log("\n-- inclusive time inside long tasks --\n" + top(inLong, 40));
await browser.close();
