// Diagnostic: watch a demo duel and log when moments appear (draws, splashes, banners, the decision dock), to
// check the pacing (shared/pacing.ts): a decision should show only after what led to it has played out.
//   node scripts/ux/pacing-probe.mjs [seconds] [baseUrl]
import { chromium } from "@playwright/test";

const secs = Number(process.argv[2] ?? 40), base = process.argv[3] ?? "http://localhost:8788";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`${base}/lobby`);
const name = page.getByPlaceholder(/e\.g\./i);
await name.or(page.getByText(/Dueling as/)).first().waitFor();
if (await name.isVisible()) { await name.fill("pacing-probe"); await page.getByRole("button", { name: /Continue as guest/ }).click(); await page.getByText(/Dueling as/).waitFor(); }
await page.getByRole("button", { name: /Watch a demo duel/ }).click();
await page.waitForURL(/\/duel\//);
await page.locator(".duel-field").waitFor({ timeout: 30_000 });
await page.evaluate(() => {
  const t0 = performance.now(), log = (window.__moments = []);
  const kinds = [["fx-draw", "draw"], ["duel-phasefx", "banner"], ["duel-engine-bar", "prompt"], ["sfx-show", "splash"], ["sfx-portal", "splash"], ["sfx-splash", "splash"], ["sfx-cutin", "splash"], ["sfx-holo", "splash"], ["sfx-comic", "splash"], ["sfx-spot", "splash"]];
  new MutationObserver((ms) => {
    for (const m of ms) for (const n of m.addedNodes) {
      if (!(n instanceof HTMLElement)) continue;
      for (const [cls, kind] of kinds) if (n.classList.contains(cls) || n.querySelector?.(`:scope > .${cls}`)) log.push({ t: Math.round(performance.now() - t0), kind, text: kind === "banner" ? n.textContent?.slice(0, 30) : undefined });
    }
  }).observe(document.body, { childList: true, subtree: true });
});
await page.waitForTimeout(secs * 1000);
const moments = await page.evaluate(() => window.__moments);
// how long after the last moment before it did each prompt appear
let last = null;
const gaps = [];
for (const m of moments) {
  if (m.kind === "prompt") { if (last) gaps.push({ at: m.t, afterMoment: last.kind, gap: m.t - last.t }); }
  else last = m;
}
const count = (k) => moments.filter((m) => m.kind === k).length;
console.log(JSON.stringify({ draws: count("draw"), banners: count("banner"), splashes: count("splash"), prompts: count("prompt"), errors }, null, 0));
console.log(moments.slice(0, 60).map((m) => `${String(m.t).padStart(6)}ms ${m.kind}${m.text ? " " + m.text : ""}`).join("\n"));
console.log("prompt gaps after the last moment (ms):", gaps.slice(0, 25).map((g) => `${g.afterMoment}+${g.gap}`).join(" "));
await browser.close();
