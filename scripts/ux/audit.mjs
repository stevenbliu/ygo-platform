// Duel UX audit: plays demo duels in a real browser at several window sizes, samples moments as they happen,
// runs the checks in scripts/ux/checks.js at each one (decision visible and not too early, readable text, hit
// targets, overlaps, cut-off text, essentials on screen, stutters), and writes ux-report/:
//   index.html   contact sheet: every sampled moment's screenshot with its findings, and the findings ranked
//   report.json  the same as data (for diffs between runs)
// Read the report (and the screenshots) against docs/ux-rubric.md.
//
//   npm run ux                      (local dev server on :8788: npm run build && npm run dev:worker)
//   node scripts/ux/audit.mjs [--secs 60] [--every 2500] [--base http://localhost:8788] [--sizes 1920x1080,1366x768,390x844]
import { chromium } from "@playwright/test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const BASE = arg("base", "http://localhost:8788");
const SECS = Number(arg("secs", 60));
const EVERY = Number(arg("every", 2500));
const SIZES = arg("sizes", "1920x1080,1366x768,390x844").split(",").map((s) => { const [w, h] = s.split("x").map(Number); return { width: w, height: h }; });
const OUT = "ux-report";
const here = dirname(fileURLToPath(import.meta.url));
const checksSrc = readFileSync(join(here, "checks.js"), "utf8");

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, "shots"), { recursive: true });

const browser = await chromium.launch();
const samples = [];
for (const size of SIZES) {
  const phone = size.width < 640;
  const page = await browser.newPage({ viewport: size, ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(`${checksSrc}\nwindow.uxChecks = uxChecks;\nwindow.addEventListener("DOMContentLoaded", () => uxInstall());`);
  await page.goto(`${BASE}/lobby`);
  const name = page.getByPlaceholder(/e\.g\./i);
  await name.or(page.getByText(/Dueling as/)).first().waitFor({ timeout: 20_000 });
  if (await name.isVisible()) { await name.fill("ux-audit"); await page.getByRole("button", { name: /Continue as guest/ }).click(); await page.getByText(/Dueling as/).waitFor(); }
  await page.getByRole("button", { name: /Watch a demo duel/ }).click();
  await page.waitForURL(/\/duel\//);
  await page.locator(".duel-field").waitFor({ timeout: 30_000 });
  const end = Date.now() + SECS * 1000;
  let n = 0;
  while (Date.now() < end) {
    await page.waitForTimeout(EVERY);
    const re = page.getByRole("button", { name: /^Rematch$|Accept rematch/ });
    if (await re.count()) await re.first().click().catch(() => undefined);
    const findings = await page.evaluate("uxChecks()");
    const ctx = await page.evaluate(() => ({
      phase: document.querySelector(".duel-page")?.getAttribute("data-phase") ?? "",
      deciding: !!document.querySelector(".duel-engine-bar"),
      turn: document.querySelector(".duel-turnno b")?.textContent ?? "",
    }));
    const shot = `shots/${size.width}x${size.height}-${String(n++).padStart(3, "0")}.png`;
    await page.screenshot({ path: join(OUT, shot) });
    samples.push({ size: `${size.width}x${size.height}`, t: n * EVERY, shot, ...ctx, findings });
  }
  for (const e of errors) samples.push({ size: `${size.width}x${size.height}`, t: 0, shot: "", findings: [{ severity: "high", rule: "page-error", id: `page-error:${e.slice(0, 60)}`, detail: e }] });
  await page.close();
}
await browser.close();

// unique findings, ranked: severity, then how often they showed up
const RANK = { high: 0, medium: 1, low: 2 };
const byId = new Map();
for (const s of samples) for (const f of s.findings) {
  const cur = byId.get(f.id) ?? { ...f, count: 0, sizes: new Set(), firstShot: s.shot };
  cur.count++; cur.sizes.add(s.size);
  byId.set(f.id, cur);
}
const unique = [...byId.values()].map((f) => ({ ...f, sizes: [...f.sizes] }))
  .sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.count - a.count);
const totals = { high: 0, medium: 0, low: 0 };
for (const f of unique) totals[f.severity]++;
writeFileSync(join(OUT, "report.json"), JSON.stringify({ base: BASE, when: new Date().toISOString(), totals, findings: unique, samples }, null, 1));

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const html = `<!doctype html><meta charset="utf-8"><title>Duel UX audit</title>
<style>
:root { color-scheme: light dark; --bg: #f6f4ef; --fg: #1d1b18; --muted: #6b665d; --card: #fff; --line: #ddd6c8; --high: #c0392b; --medium: #c27c0e; --low: #5b6b7a; }
@media (prefers-color-scheme: dark) { :root { --bg: #15140f; --fg: #ece7dc; --muted: #a39d90; --card: #1f1d17; --line: #38342a; } }
body { margin: 0; padding: 24px 16px 64px; background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, sans-serif; }
main { max-width: 1400px; margin: 0 auto; }
h1 { margin: 0 0 4px; font-size: 22px; } h2 { margin: 32px 0 10px; font-size: 17px; }
.muted { color: var(--muted); }
.totals span { display: inline-block; margin-right: 14px; font-weight: 600; }
.sev { display: inline-block; min-width: 56px; padding: 1px 6px; border-radius: 4px; color: #fff; font-size: 12px; text-align: center; }
.sev.high { background: var(--high); } .sev.medium { background: var(--medium); } .sev.low { background: var(--low); }
table { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--line); }
td, th { padding: 6px 8px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
th { font-size: 12px; color: var(--muted); font-weight: 600; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
figure { margin: 0; background: var(--card); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
figure img { width: 100%; display: block; cursor: zoom-in; }
figcaption { padding: 8px 10px; font-size: 12px; }
figcaption ul { margin: 6px 0 0; padding-left: 16px; }
a { color: inherit; }
</style>
<main>
<h1>Duel UX audit</h1>
<p class="muted">${esc(BASE)} · ${new Date().toLocaleString()} · ${SIZES.map((s) => `${s.width}×${s.height}`).join(", ")} · a sample every ${EVERY} ms for ${SECS} s each · rules: docs/ux-rubric.md</p>
<p class="totals"><span class="sev high">high</span> ${totals.high} <span class="sev medium">medium</span> ${totals.medium} <span class="sev low">low</span> ${totals.low}</p>
<h2>Findings</h2>
<table><tr><th>Severity</th><th>Rule</th><th>What</th><th>Where</th><th>Seen</th><th>Sizes</th></tr>
${unique.map((f) => `<tr><td><span class="sev ${f.severity}">${f.severity}</span></td><td>${esc(f.rule)}</td><td>${esc(f.detail)}</td><td>${esc(f.where)}</td><td>${f.count}×${f.firstShot ? ` · <a href="${esc(f.firstShot)}">first</a>` : ""}</td><td>${esc(f.sizes.join(", "))}</td></tr>`).join("\n")}
</table>
<h2>Moments</h2>
<div class="grid">
${samples.filter((s) => s.shot).map((s) => `<figure><a href="${esc(s.shot)}"><img loading="lazy" src="${esc(s.shot)}" alt=""></a><figcaption><b>${esc(s.size)}</b> · ${(s.t / 1000).toFixed(1)} s · turn ${esc(s.turn)} · ${esc(s.phase)}${s.deciding ? " · deciding" : ""}${s.findings.length ? `<ul>${s.findings.map((f) => `<li><span class="sev ${f.severity}">${f.severity}</span> ${esc(f.detail)}</li>`).join("")}</ul>` : ""}</figcaption></figure>`).join("\n")}
</div>
</main>`;
writeFileSync(join(OUT, "index.html"), html);
console.log(JSON.stringify({ totals, top: unique.slice(0, 12).map((f) => `${f.severity} ${f.rule}: ${f.detail} [${f.where ?? ""}] x${f.count}`) }, null, 1));
console.log(`report: ${join(OUT, "index.html")}`);
