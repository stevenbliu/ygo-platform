// Records scene fixtures (public/scenes/*.json): plays demo duels against the local dev server and, the first
// time each kind of moment comes up (an Extra Deck you can summon from, a card to pick from the GY, a chance to
// chain...), saves what the page had received at that moment: room, session, board, prompt. /duel/scene-<name>
// replays it (src/client/components/duel/sceneSocket.ts). Re-record when the message shapes change.
//
//   node scripts/ux/record-scenes.mjs [--secs 240] [--base http://localhost:8788] [--only name,name]
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const BASE = arg("base", "http://localhost:8788");
const SECS = Number(arg("secs", 240));
const ONLY = arg("only", "");
const OUT = "public/scenes";

// Which moments to keep. `when(prompt)` runs in the page on each prompt meant for you.
// Note: prompts the board answers by itself (zone choices) can't be scenes.
const SCENES = [
  ["main-phase", "Your Main Phase: hand cards to summon / activate (their glow and tags)",
    "p.kind === 'idle' && p.summons.length > 0 && p.activates.some((r) => r.location === 'hand')"],
  ["extra-summonable", "Main Phase with Extra Deck monsters you can Special Summon (the pile's glow and menu)",
    "p.kind === 'idle' && p.specialSummons.some((r) => r.location === 'extra')"],
  ["battle", "Your Battle Phase: monsters that can attack",
    "p.kind === 'battle' && p.attacks.length > 0"],
  ["chain-respond", "A chance to chain a card or effect",
    "p.kind === 'selectChain' && !p.forced && p.cards.length > 0"],
  ["pick-from-pile", "Choose cards from a pile (Deck / GY / banished): the docked picker",
    "p.kind === 'selectCard' && p.cards.some((c) => ['deck', 'gy', 'banished', 'extra'].includes(c.location))"],
  ["pick-on-board", "Choose cards on the field",
    "p.kind === 'selectCard' && p.cards.length > 0 && p.cards.every((c) => ['monster', 'spelltrap'].includes(c.location))"],
  ["position", "Choose a battle position", "p.kind === 'selectPosition'"],
  ["effect-yes-no", "Use an optional effect?", "p.kind === 'effectYesNo'"],
].filter(([n]) => !ONLY || ONLY.split(",").includes(n));

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
await page.addInitScript(`
  window.__scenes = {};
  const wanted = ${JSON.stringify(SCENES.map(([name, about, when]) => ({ name, about, when })))}
    .map((s) => ({ ...s, test: new Function("p", "return " + s.when) }));
  const last = {};
  window.__duelMsg = (m) => {
    if (m.t === "room" || m.t === "session" || m.t === "state") last[m.t] = m;
    if (m.t !== "prompt" || !m.prompt || !last.room || m.prompt.player !== last.room.you) return;
    for (const s of wanted) {
      if (window.__scenes[s.name]) continue;
      let hit = false;
      try { hit = s.test(m.prompt); } catch { /* shape didn't match */ }
      if (!hit || !last.session || !last.state) continue;
      // a scene doesn't tick: the clock is stopped (screenshots stay the same)
      const session = structuredClone(last.session);
      if (session.session?.timer) session.session.timer.running = null;
      window.__scenes[s.name] = { name: s.name, about: s.about, msgs: [last.room, session, last.state, m] };
    }
  };
`);
const start = Date.now();
await page.goto(`${BASE}/lobby`);
const name = page.getByPlaceholder(/e\.g\./i);
await name.or(page.getByText(/Dueling as/)).first().waitFor({ timeout: 20_000 });
if (await name.isVisible()) { await name.fill("scenes"); await page.getByRole("button", { name: /Continue as guest/ }).click(); await page.getByText(/Dueling as/).waitFor(); }
await page.getByRole("button", { name: /Watch a demo duel/ }).click();
await page.locator(".duel-field").waitFor({ timeout: 30_000 });
let got = [];
while (Date.now() - start < SECS * 1000) {
  await page.waitForTimeout(2000);
  const re = page.getByRole("button", { name: /^Rematch$|Accept rematch/ });
  if (await re.count()) await re.first().click().catch(() => undefined);
  got = await page.evaluate(() => Object.keys(window.__scenes));
  if (got.length === SCENES.length) break;
}
const scenes = await page.evaluate(() => window.__scenes);
await browser.close();
for (const s of Object.values(scenes)) writeFileSync(join(OUT, `${s.name}.json`), JSON.stringify(s));
// the index: every fixture on disk (old ones kept when this run only re-recorded some)
const { readdirSync, readFileSync } = await import("node:fs");
const index = readdirSync(OUT).filter((f) => f.endsWith(".json") && f !== "index.json")
  .map((f) => { const s = JSON.parse(readFileSync(join(OUT, f), "utf8")); return { name: s.name, about: s.about }; });
writeFileSync(join(OUT, "index.json"), JSON.stringify(index, null, 1));
const missing = SCENES.map(([n]) => n).filter((n) => !scenes[n]);
console.log(`recorded: ${Object.keys(scenes).join(", ") || "none"}${missing.length ? `\nnot seen in ${SECS}s (run again / longer): ${missing.join(", ")}` : ""}`);
