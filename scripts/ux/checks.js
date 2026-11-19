// In-page UX checks for the duel (scripts/ux/audit.mjs runs this in the browser at each sampled moment).
// Plain browser JS (no imports): evaluated with page.evaluate. Returns findings:
//   { id, severity: "high" | "medium" | "low", rule, detail, where? }
// `id` is stable across samples (the audit counts and groups by it). Rules: docs/ux-rubric.md.
// eslint-disable-next-line no-unused-vars
function uxChecks() {
  const out = [];
  const add = (severity, rule, id, detail, where) => out.push({ severity, rule, id: `${rule}:${id}`, detail, where });
  const page = document.querySelector(".duel-page");
  if (!page) return out;
  const zoom = Number(getComputedStyle(page).zoom) || 1;
  const vw = innerWidth, vh = innerHeight;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return null;
    return r;
  };
  const label = (el) => {
    const t = (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
    const cls = [...el.classList].filter((c) => !c.startsWith("is-")).slice(0, 2).join(".");
    return `${el.tagName.toLowerCase()}${cls ? "." + cls : ""}${t ? ` "${t}"` : ""}`;
  };
  // inside the zoomed page (the animation layer undoes the zoom)
  const zoomOf = (el) => (el.closest(".duel-anim-layer") ? 1 : page.contains(el) ? zoom : 1);

  // 1. the decision: when the duel asks you something, its panel and buttons are on screen and not covered
  const bar = document.querySelector(".duel-engine-bar");
  const barRect = bar && visible(bar);
  // (skip while it animates in: its entrance scales it past its box for a moment)
  const settling = bar && bar.getAnimations({ subtree: false }).some((a) => a.playState === "running");
  if (barRect && !settling) {
    if (barRect.bottom > vh + 1 || barRect.right > vw + 1 || barRect.top < -1 || barRect.left < -1) add("high", "decision-visible", "offscreen", `The decision panel runs off the screen (${Math.round(barRect.left)},${Math.round(barRect.top)} ${Math.round(barRect.width)}x${Math.round(barRect.height)})`, label(bar));
    for (const b of bar.querySelectorAll("button")) {
      const r = visible(b);
      if (!r) continue;
      const x = Math.min(vw - 1, Math.max(0, r.left + r.width / 2)), y = Math.min(vh - 1, Math.max(0, r.top + r.height / 2));
      const top = document.elementFromPoint(x, y);
      if (top && !b.contains(top) && !top.closest(".duel-anim-layer")) add("high", "decision-visible", `covered:${b.textContent.trim().slice(0, 20)}`, `A decision button is covered by ${label(top)}`, label(b));
    }
  }

  // 2. pacing: a decision appeared while the moment that led to it was still playing (shared/pacing.ts)
  const early = window.__uxEarlyPrompts ?? [];
  for (const e of early.splice(0)) add("high", "decision-after-moment", e.kind, `A decision appeared ${e.ms} ms into a ${e.kind} that was still playing`);

  // 3. readable text: effective size on screen (CSS size x the page's zoom)
  const LABELS = ".duel-pile-name, .duel-pile-count, .dl-phase-text, .duel-trait, .duel-badge, .duel-chip, .duel-clock-label, .duel-zone-label, .duel-source-tag, .duel-chainstack-title, .duel-engine-bar-kicker, .duel-phasefx-sub, .duel-pick-count, .duel-lp > span:not(.duel-lp-num), small";
  const small = new Map();
  for (const el of page.querySelectorAll("b, span, small, p, li, button, label, h1, h2, h3, h4, div, a, td, th")) {
    if (!el.childNodes.length || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1)) continue;
    // a card's name standing in for art that didn't load (local dev without images): not real UI text
    if (el.closest(".duel-card-fallback")) continue;
    const r = visible(el);
    if (!r || r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
    const px = parseFloat(getComputedStyle(el).fontSize) * zoomOf(el);
    // labels and badges (pile counts, zone names, chips, traits) may go down to 9.5 px; text you read, 11 px
    const min = el.matches(LABELS) ? 9.5 : 11;
    if (px >= min) continue;
    const key = label(el).replace(/ ".*$/, "");
    const cur = small.get(key);
    if (!cur || px < cur.px) small.set(key, { px, el });
  }
  for (const [key, { px, el }] of small) { const min = el.matches(LABELS) ? 9.5 : 11; add(px < min - 1.5 ? "medium" : "low", "text-size", key, `${min === 11 ? "Text" : "A label"} shows at ${px.toFixed(1)}px on screen (under ${min}px)`, label(el)); }

  // 4. hit targets: things you click are at least 24px each way on screen
  // (links inside running text, like card names in the log, are exempt: WCAG 2.5.8's inline exception)
  const inline = (el) => getComputedStyle(el).display === "inline";
  const clickables = [...page.querySelectorAll("button, [role=button], a[href], select, input:not([type=hidden])")].filter((el) => !el.disabled && !inline(el));
  const targetRects = [];
  for (const el of clickables) {
    const r = visible(el);
    if (!r || r.bottom < 0 || r.top > vh) continue;
    targetRects.push([el, r]);
    if (r.width < 23.5 || r.height < 23.5) add(r.width < 18 || r.height < 18 ? "medium" : "low", "hit-target", label(el).replace(/ ".*$/, ""), `A control is ${Math.round(r.width)}x${Math.round(r.height)}px on screen (under 24px)`, label(el));
    // (hand cards peek from the screen edge by design)
    if (!el.closest(".duel-hand") && (r.right > vw + 1 || r.bottom > vh + 1 || r.left < -1)) add("medium", "offscreen-control", label(el), "A control is partly off the screen", label(el));
  }
  // 5. controls on top of each other
  for (let i = 0; i < targetRects.length; i++) for (let j = i + 1; j < targetRects.length; j++) {
    const [a, ra] = targetRects[i], [b, rb] = targetRects[j];
    if (a.contains(b) || b.contains(a)) continue;
    // a dialog / sheet / menu (or the hovered card's preview) covering the board is meant to: only overlaps inside
    // the same layer count
    const layerOf = (el) => el.closest("[role=dialog], [role=menu], .duel-engine-dialog, .duel-engine-pos, .duel-modal, .duel-menu, .duel-floatpreview");
    if (layerOf(a) !== layerOf(b)) continue;
    // a hand is a fan: its cards overlap by design
    if (a.closest(".duel-hand") && a.closest(".duel-hand") === b.closest(".duel-hand")) continue;
    const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left), h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
    if (w <= 4 || h <= 4) continue;
    const share = (w * h) / Math.min(ra.width * ra.height, rb.width * rb.height);
    if (share > 0.3) add("medium", "controls-overlap", `${label(a)}|${label(b)}`, `Two controls overlap (${Math.round(share * 100)}% of the smaller)`, `${label(a)} / ${label(b)}`);
  }

  // 6. cut-off text: a label wider than its box with no ellipsis
  for (const el of page.querySelectorAll("button, b, span, h1, h2, h3, label, small")) {
    // (a card's name standing in for missing art is not a label)
    if (el.closest(".duel-card-fallback, .duel-card-inner")) continue;
    const r = visible(el);
    if (!r || el.scrollWidth <= el.clientWidth + 2 || !el.clientWidth) continue;
    const cs = getComputedStyle(el);
    if (cs.textOverflow === "ellipsis" || cs.overflowX === "visible" || cs.overflowX === "auto" || cs.overflowX === "scroll") continue;
    add("low", "clipped-text", label(el).replace(/ ".*$/, ""), `Text is cut off (${el.scrollWidth}px of text in a ${el.clientWidth}px box)`, label(el));
  }

  // 7. the essentials are always on screen: whose turn, the phase, both LP
  for (const [sel, what] of [[".duel-plate", "LP plates"], [".duel-turnno, .duel-turnsign, .duel-phase-cell, .duel-phasebtn", "turn / phase"]]) {
    const els = [...document.querySelectorAll(sel)].map(visible).filter(Boolean);
    const onScreen = (r) => r.top >= -1 && r.left >= -1 && r.bottom <= vh + 1 && r.right <= vw + 1;
    if (!els.length) add("medium", "essentials", what, `${what} not visible`);
    else if (sel.includes("plate") ? !els.every(onScreen) : !els.some(onScreen)) add("medium", "essentials", `${what}:offscreen`, `${what} not fully on screen without scrolling`);
  }

  // 8. smoothness: long main-thread tasks since the last sample
  const long = (window.__uxLongTasks ?? []).splice(0);
  for (const ms of long) if (ms >= 120) add(ms >= 250 ? "medium" : "low", "long-task", ms >= 250 ? "250ms+" : "120ms+", `The page froze for ${Math.round(ms)} ms (a dropped-frame stutter)`);
  return out;
}

// Installed once per page: watches for decisions that show up while a moment is still animating, and long tasks.
// eslint-disable-next-line no-unused-vars
function uxInstall() {
  window.__uxEarlyPrompts = [];
  window.__uxLongTasks = [];
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__uxLongTasks.push(e.duration); }).observe({ type: "longtask", buffered: false }); } catch { /* not supported */ }
  // the splash / summon / draw layers: a decision appearing while one of them runs is too early
  const kinds = [["fx-draw", "draw"], ["sfx-", "summon / activation"], ["duel-phasefx", "phase banner"]];
  const running = () => {
    for (const a of document.getAnimations()) {
      const t = a.effect?.target;
      if (!(t instanceof Element) || a.playState !== "running" || a.effect.getTiming().iterations === Infinity) continue;
      const host = t.closest(".duel-anim-layer > *, .duel-phasefx");
      if (!host) continue;
      const k = kinds.find(([c]) => [...host.classList].some((x) => x.startsWith(c)));
      // its fade-out (the last third) doesn't count: the next moment may start as it leaves
      const t0 = Number(a.currentTime ?? 0), len = Number(a.effect.getComputedTiming().endTime ?? 0);
      if (k && (!len || t0 < len * 0.66)) return { kind: k[1], ms: Math.round(t0) };
    }
    return null;
  };
  let lastPrompt = "";
  new MutationObserver(() => {
    const bar = document.querySelector(".duel-engine-bar");
    const key = bar ? bar.textContent.slice(0, 80) : "";
    if (key && key !== lastPrompt) {
      const r = running();
      if (r) window.__uxEarlyPrompts.push(r);
    }
    lastPrompt = key;
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
}
