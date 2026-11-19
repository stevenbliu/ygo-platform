// Scene tests: every recorded duel moment (public/scenes/, /duel/scene-<name>), plus a few interactions on them,
// at desktop and laptop sizes. Each one:
//   - runs the UX checks (scripts/ux/checks.js, rules in docs/ux-rubric.md): no high / medium findings
//   - runs axe (accessibility): no serious / critical violations beyond the known list below
//   - matches its screenshot baseline (local only: SCENE_SHOTS=0 skips; --update-snapshots accepts changes)
// Plus: every card-art splash style holds the stage through the middle of its run (summon lab).
//
//   npm run scenes                       (local dev server on :8788)
//   npm run scenes -- --update-snapshots (accept the new look; review the diff report first)
//   BASE_URL=https://... SCENE_SHOTS=0 npm run scenes   (CI: checks only, against the live site)
import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const checksSrc = readFileSync(join(import.meta.dirname, "checks.js"), "utf8");
const scenes: { name: string; about: string }[] = JSON.parse(readFileSync(join(import.meta.dirname, "../../public/scenes/index.json"), "utf8"));
const SHOTS = process.env.SCENE_SHOTS !== "0";

/** axe rules that fail today for reasons we accept (fix them, then drop them from here). */
const AXE_KNOWN = new Set<string>([]);

/** Extra steps on a scene: open what the scene is about, so its overlay is checked and baselined too. */
const VARIANTS: { scene: string; name: string; steps: (p: Page) => Promise<void> }[] = [
  {
    scene: "extra-summonable", name: "menu",
    steps: async (p) => { await p.locator(".duel-pile-extra.can-summon").first().click(); await p.locator(".duel-menu").waitFor(); },
  },
  {
    scene: "extra-summonable", name: "picker-hover",
    steps: async (p) => {
      await p.locator(".duel-pile-extra.can-summon").first().click();
      await p.getByRole("menuitem", { name: /Special Summon/ }).click();
      await p.locator(".duel-modal-backdrop.is-docked .duel-viewer-cell .duel-card").first().hover();
      await p.locator(".duel-floatpreview.is-shown").waitFor();
    },
  },
];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(`${checksSrc}\nwindow.uxChecks = uxChecks; window.uxSampleSplash = uxSampleSplash;\nwindow.addEventListener("DOMContentLoaded", () => uxInstall());`);
});

async function openScene(page: Page, name: string) {
  await page.goto(`/duel/scene-${name}`);
  await expect(page.locator("html")).toHaveAttribute("data-scene", "ready", { timeout: 20_000 });
  await page.locator(".duel-field").waitFor();
  await page.waitForTimeout(1200);   // card data, images, the entrance animations
}

async function checkPage(page: Page, shot: string) {
  // the UX checks: nothing high / medium (stutters are the audit's business: a scene doesn't animate)
  const findings = (await page.evaluate("uxChecks()")) as { severity: string; rule: string; detail: string; where?: string }[];
  const bad = findings.filter((f) => f.severity !== "low" && f.rule !== "long-task");
  test.info().annotations.push(...findings.map((f) => ({ type: `ux ${f.severity}`, description: `${f.rule}: ${f.detail} ${f.where ?? ""}` })));
  expect(bad, bad.map((f) => `${f.rule}: ${f.detail} [${f.where ?? ""}]`).join("\n")).toEqual([]);

  // accessibility: no serious / critical violations (contrast, names, roles...)
  // (the hover preview's text fades out at its bottom edge on purpose: axe would read the fade as low contrast)
  const axe = await new AxeBuilder({ page }).include(".duel-page").exclude(".duel-floatpreview .card-text").analyze();
  const serious = axe.violations.filter((v) => (v.impact === "serious" || v.impact === "critical") && !AXE_KNOWN.has(v.id));
  test.info().annotations.push(...axe.violations.map((v) => ({ type: `axe ${v.impact}`, description: `${v.id}: ${v.help} (${v.nodes.length}×) ${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(" | ")}` })));
  expect(serious.map((v) => `${v.id}: ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);

  if (SHOTS) await expect(page).toHaveScreenshot(`${shot}.png`, { animations: "disabled", caret: "hide", maxDiffPixelRatio: 0.01, timeout: 15_000 });
}

for (const s of scenes) {
  test(`scene: ${s.name}`, async ({ page }) => {
    test.info().annotations.push({ type: "about", description: s.about });
    await openScene(page, s.name);
    await checkPage(page, s.name);
  });
}

for (const v of VARIANTS) {
  test(`scene: ${v.scene} → ${v.name}`, async ({ page }) => {
    await openScene(page, v.scene);
    await v.steps(page);
    await page.waitForTimeout(400);
    if (v.name === "picker-hover") {
      // the hovered card's preview is on top of the picker, and the board behind the picker isn't blurred / dimmed
      const top = await page.evaluate(() => {
        const r = document.querySelector(".duel-floatpreview.is-shown")!.getBoundingClientRect();
        const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 3);
        const back = getComputedStyle(document.querySelector(".duel-modal-backdrop.is-docked")!);
        return { previewOnTop: !!el?.closest(".duel-floatpreview"), blur: back.backdropFilter, bg: back.backgroundColor };
      });
      expect(top.previewOnTop, "the hover preview is covered").toBe(true);
      expect(top.blur, "the board behind a picker is blurred").toBe("none");
      expect(top.bg, "the board behind a picker is dimmed").toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    }
    await checkPage(page, `${v.scene}--${v.name}`);
  });
}

test("every splash style holds the stage", async ({ page }) => {
  test.skip(test.info().project.name !== "desktop", "once is enough");
  await page.goto("/dev/summons");
  const select = page.getByRole("combobox").filter({ has: page.locator("option[value=manga]") }).first();
  const styles = await select.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
  const problems: string[] = [];
  for (const style of styles) {
    await select.selectOption(style);
    await page.waitForTimeout(200);
    const sample = page.evaluate("uxSampleSplash()") as Promise<{ samples: [number, number][]; duration: number } | null>;
    await page.getByRole("button", { name: "Synchro Summon", exact: true }).click();
    const r = await sample;
    if (!r || r.samples.length < 5) { problems.push(`${style}: no splash seen`); continue; }
    // through the middle of its run the splash is (nearly) fully visible
    const mid = r.samples.filter(([p]) => p >= 0.3 && p <= 0.7);
    const low = mid.filter(([, v]) => v < 0.85);
    test.info().annotations.push({ type: "splash", description: `${style}: ${r.duration} ms, min mid visibility ${Math.min(...mid.map(([, v]) => v)).toFixed(2)}` });
    if (!mid.length) problems.push(`${style}: no samples mid-run`);
    else if (low.length > mid.length * 0.1) problems.push(`${style}: fades early (visibility ${low[0][1]} at ${Math.round(low[0][0] * 100)}% of its run)`);
    await page.waitForTimeout(1500);
  }
  expect(problems).toEqual([]);
});
