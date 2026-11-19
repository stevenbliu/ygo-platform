// More card-art splashes, in the bold graphic family of comic / banner / cut-in (splash.ts dispatches here):
// manga panels, double slash, pop-art grid, stamp slam, film strip, ink brush. Styles: anim/splash-graphic.css.
// Each returns when the board is clear again (ms from now), like splash.ts's own styles. Timelines are linear:
// an easing on the whole animation would warp the keyframe offsets (a hold at 0.8 would end near half way).
import { cardImage } from "../../../../api.ts";
import { bit, ctr } from "./core.ts";
import type { Run } from "./core.ts";
import type { SplashOpts } from "./splash.ts";
import { foilParts } from "../../../../../shared/rarity.ts";
import "../splash-graphic.css";

const art = (o: SplashOpts) => `url("${cardImage(o.code, "crop")}")`;
/** The kicker and name filled in as text (never as HTML: card names are data). */
function texts(el: HTMLElement, o: SplashOpts) {
  el.querySelectorAll("small").forEach((s) => { s.textContent = o.kicker; });
  el.querySelectorAll("b").forEach((b) => { b.textContent = o.name; });
}
/** Fade a part in at `from` and out at `to` (fractions of the splash). */
function window_(run: Run, el: Element, ms: number, wait: number, from: number, to: number, enter = "translateY(10px)") {
  run(el, [{ opacity: 0, transform: enter }, { offset: from, opacity: 0, transform: enter }, { offset: Math.min(to, from + 0.08), opacity: 1, transform: "none" }, { offset: to, opacity: 1, transform: "none" }, { opacity: 0, transform: "none" }],
    { duration: ms, delay: wait, easing: "linear", fill: "both" });
}
/** Vertical band around the card's row, kept on screen. */
function bandY(o: SplashOpts, h: number) {
  return Math.min(innerHeight - h - 16, Math.max(16, ctr(o.at).y - h / 2));
}

/** Manga page: three slanted panels slam in one after another: a close-up of the art, the whole card, then the
 *  name over speed lines. */
export function manga(layer: HTMLElement, run: Run, o: SplashOpts, wait: number, ms: number): number {
  const w = Math.round(Math.min(innerWidth * 0.86, 1280)), h = Math.round(Math.min(innerHeight * (o.big ? 0.42 : 0.36), 400));
  const el = bit(layer, `sfx-g sfx-manga ${o.big ? "is-big" : ""}`, { left: `${(innerWidth - w) / 2}px`, top: `${bandY(o, h)}px`, width: `${w}px`, height: `${h}px`, "--c": o.tone, "--art": art(o) }, ms, wait,
    `<div class="sfx-manga-p p1"><i class="sfx-manga-art"></i></div>
     <div class="sfx-manga-p p2"><img alt="" src="${cardImage(o.code, "full")}"></div>
     <div class="sfx-manga-p p3"><i class="sfx-manga-lines"></i><div class="sfx-manga-text"><small></small><b></b></div></div>`);
  texts(el, o);
  [".p1", ".p2", ".p3"].forEach((sel, i) => {
    const at = 0.04 + i * 0.1;
    run(el.querySelector(sel)!, [{ opacity: 0, transform: "scale(1.35) rotate(-2deg)" }, { offset: at, opacity: 0, transform: "scale(1.35) rotate(-2deg)" },
      { offset: at + 0.07, opacity: 1, transform: "scale(.97)" }, { offset: at + 0.11, transform: "scale(1)" }, { offset: 0.82, opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(1.04)" }],
    { duration: ms, delay: wait, easing: "linear", fill: "both" });
  });
  run(el.querySelector(".sfx-manga-art")!, [{ transform: "scale(1.5)" }, { transform: "scale(1.25)" }], { duration: ms, delay: wait, easing: "linear", fill: "both" });
  return wait + ms * 0.85;
}

/** Double slash: two blade cuts tear across the board with the art showing through, the name slams into the gap. */
export function slash(layer: HTMLElement, run: Run, o: SplashOpts, wait: number, ms: number): number {
  const h = Math.round(Math.min(innerHeight * (o.big ? 0.5 : 0.44), 460));
  const el = bit(layer, `sfx-g sfx-slash ${o.big ? "is-big" : ""}`, { left: "0px", top: `${bandY(o, h)}px`, width: `${innerWidth}px`, height: `${h}px`, "--c": o.tone, "--art": art(o) }, ms, wait,
    `<div class="sfx-slash-cut c1"><i></i></div><div class="sfx-slash-cut c2"><i></i></div><div class="sfx-slash-text"><small></small><b></b></div>`);
  texts(el, o);
  const d = o.mine ? 1 : -1;
  run(el.querySelector(".c1")!, [{ clipPath: d > 0 ? "inset(0 100% 0 0)" : "inset(0 0 0 100%)" }, { offset: 0.1, clipPath: "inset(0 0 0 0)" }, { offset: 0.8, clipPath: "inset(0 0 0 0)", opacity: 1 }, { clipPath: "inset(0 0 0 0)", opacity: 0 }],
    { duration: ms, delay: wait, easing: "linear", fill: "both" });
  run(el.querySelector(".c2")!, [{ clipPath: d > 0 ? "inset(0 0 0 100%)" : "inset(0 100% 0 0)" }, { offset: 0.08, clipPath: d > 0 ? "inset(0 0 0 100%)" : "inset(0 100% 0 0)" }, { offset: 0.18, clipPath: "inset(0 0 0 0)" }, { offset: 0.8, clipPath: "inset(0 0 0 0)", opacity: 1 }, { clipPath: "inset(0 0 0 0)", opacity: 0 }],
    { duration: ms, delay: wait, easing: "linear", fill: "both" });
  el.querySelectorAll(".sfx-slash-cut i").forEach((a, i) => run(a, [{ transform: `translateX(${(i ? -4 : 4) * d}%) scale(1.15)` }, { transform: `translateX(${(i ? 4 : -4) * d}%) scale(1.15)` }], { duration: ms, delay: wait, easing: "linear", fill: "both" }));
  run(el.querySelector(".sfx-slash-text")!, [{ opacity: 0, transform: "translate(-50%, -50%) scale(2.6)" }, { offset: 0.2, opacity: 0, transform: "translate(-50%, -50%) scale(2.6)" },
    { offset: 0.27, opacity: 1, transform: "translate(-50%, -50%) scale(.94)" }, { offset: 0.31, transform: "translate(-50%, -50%) scale(1)" }, { offset: 0.8, opacity: 1, transform: "translate(-50%, -50%) scale(1.03)" }, { opacity: 0, transform: "translate(-50%, -50%) scale(1.1)" }],
  { duration: ms, delay: wait, easing: "linear", fill: "both" });
  return wait + ms * 0.84;
}

/** Pop-art grid: the art in four clashing colour tiles with halftone dots, the name as a cut-out ransom note. */
export function popart(layer: HTMLElement, run: Run, o: SplashOpts, wait: number, ms: number): number {
  const s = Math.round(Math.min(innerHeight * (o.big ? 0.54 : 0.46), 500));
  const z = ctr(o.at), side = o.mine ? 1 : -1;
  const cx = Math.min(innerWidth - s / 2 - 12, Math.max(s / 2 + 12, z.x + side * s * 0.5)), cy = Math.min(innerHeight - s / 2 - 40, Math.max(s / 2 + 12, z.y - s * 0.2));
  const el = bit(layer, `sfx-g sfx-pop ${o.big ? "is-big" : ""}`, { left: `${cx - s / 2}px`, top: `${cy - s / 2}px`, width: `${s}px`, height: `${s}px`, "--c": o.tone, "--art": art(o) }, ms, wait,
    `<div class="sfx-pop-grid"><i class="t1"></i><i class="t2"></i><i class="t3"></i><i class="t4"></i></div><div class="sfx-pop-note"><small></small><span class="sfx-pop-name"></span></div>`);
  el.querySelector("small")!.textContent = o.kicker;
  // the name as cut-out letters, each its own scrap of paper
  const name = el.querySelector(".sfx-pop-name")!;
  [...o.name.slice(0, 34)].forEach((ch, i) => {
    const sp = document.createElement("span");
    sp.textContent = ch;
    if (ch === " ") sp.className = "is-gap";
    else sp.style.setProperty("--r", `${((i * 37) % 13) - 6}deg`), sp.className = `k${i % 5}`;
    name.appendChild(sp);
  });
  el.querySelectorAll(".sfx-pop-grid i").forEach((t, i) => run(t, [{ opacity: 0, transform: "scale(.3)" }, { offset: 0.03 + i * 0.05, opacity: 0, transform: "scale(.3)" }, { offset: 0.1 + i * 0.05, opacity: 1, transform: "scale(1.06)" }, { offset: 0.16 + i * 0.05, transform: "scale(1)" }, { offset: 0.82, opacity: 1, transform: "scale(1)" }, { opacity: 0, transform: "scale(.9)" }],
    { duration: ms, delay: wait, easing: "linear", fill: "both" }));
  window_(run, el.querySelector(".sfx-pop-note")!, ms, wait, 0.25, 0.8, "translate(-50%, 0) rotate(-8deg) scale(1.4)");
  return wait + ms * 0.84;
}

/** Stamp slam: the card comes down like a rubber stamp, ink bursts out, the board shakes, the kicker stamped on. */
export function stamp(layer: HTMLElement, run: Run, o: SplashOpts, wait: number, ms: number): number {
  const h = Math.round(Math.min(innerHeight * (o.big ? 0.5 : 0.42), 470)), w = Math.round(h * 59 / 86);
  const z = ctr(o.at);
  const cx = Math.min(innerWidth - w - 16, Math.max(w + 16, z.x)), cy = Math.min(innerHeight - h / 2 - 50, Math.max(h / 2 + 16, z.y - h * 0.3));
  const el = bit(layer, `sfx-g sfx-stamp ${o.big ? "is-big" : ""}`, { left: `${cx - w}px`, top: `${cy - h / 2}px`, width: `${w * 2}px`, height: `${h}px`, "--c": o.tone }, ms, wait,
    `<i class="sfx-stamp-ink"></i><i class="sfx-stamp-ring"></i><div class="sfx-stamp-card"><img alt="" src="${cardImage(o.code, "full")}"></div><div class="sfx-stamp-seal"><small></small></div><div class="sfx-stamp-name"><b></b></div>`);
  texts(el, o);
  run(el.querySelector(".sfx-stamp-card")!, [{ opacity: 0, transform: "scale(2.6) rotate(-14deg)" }, { offset: 0.12, opacity: 1, transform: "scale(.94) rotate(-5deg)" }, { offset: 0.16, transform: "scale(1.02) rotate(-6deg)" },
    { offset: 0.2, transform: "scale(1) rotate(-6deg)" }, { offset: 0.8, opacity: 1, transform: "scale(1.01) rotate(-6deg)" }, { opacity: 0, transform: "scale(1.15) rotate(-6deg)" }],
  { duration: ms, delay: wait, easing: "linear", fill: "both" });
  run(el.querySelector(".sfx-stamp-ink")!, [{ opacity: 0, transform: "translate(-50%, -50%) scale(.2)" }, { offset: 0.12, opacity: 0, transform: "translate(-50%, -50%) scale(.2)" }, { offset: 0.2, opacity: 0.9, transform: "translate(-50%, -50%) scale(1.05)" }, { offset: 0.8, opacity: 0.75, transform: "translate(-50%, -50%) scale(1.1)" }, { opacity: 0, transform: "translate(-50%, -50%) scale(1.15)" }],
    { duration: ms, delay: wait, easing: "linear", fill: "both" });
  run(el.querySelector(".sfx-stamp-ring")!, [{ opacity: 0, transform: "translate(-50%, -50%) scale(.3)" }, { offset: 0.12, opacity: 0.9, transform: "translate(-50%, -50%) scale(.4)" }, { offset: 0.4, opacity: 0, transform: "translate(-50%, -50%) scale(2.2)" }, { opacity: 0 }],
    { duration: ms, delay: wait, easing: "linear", fill: "both" });
  run(el.querySelector(".sfx-stamp-seal")!, [{ opacity: 0, transform: "rotate(12deg) scale(2.2)" }, { offset: 0.24, opacity: 0, transform: "rotate(12deg) scale(2.2)" }, { offset: 0.3, opacity: 1, transform: "rotate(12deg) scale(.95)" }, { offset: 0.33, transform: "rotate(12deg) scale(1)" }, { offset: 0.8, opacity: 1, transform: "rotate(12deg) scale(1)" }, { opacity: 0, transform: "rotate(12deg) scale(1)" }],
    { duration: ms, delay: wait, easing: "linear", fill: "both" });
  window_(run, el.querySelector(".sfx-stamp-name")!, ms, wait, 0.22, 0.8);
  // the board shakes on impact
  const board = document.querySelector(".duel-page .duel-board-wrap");
  if (board) run(board, [{ translate: "0 0" }, { offset: 0.1, translate: "0 0" }, { offset: 0.13, translate: "-6px 4px" }, { offset: 0.16, translate: "5px -3px" }, { offset: 0.19, translate: "-3px 2px" }, { offset: 0.22, translate: "0 0" }, { translate: "0 0" }],
    { duration: ms, delay: wait, easing: "linear" });
  return wait + ms * 0.84;
}

/** Film strip: three frames of the art race across the middle, slow down, the centre frame holds with the name. */
export function film(layer: HTMLElement, run: Run, o: SplashOpts, wait: number, ms: number): number {
  const h = Math.round(Math.min(innerHeight * (o.big ? 0.36 : 0.3), 320)), fw = Math.round(h * 1.3);
  const el = bit(layer, `sfx-g sfx-film ${o.big ? "is-big" : ""}`, { left: "0px", top: `${bandY(o, h + 60)}px`, width: `${innerWidth}px`, height: `${h + 60}px`, "--c": o.tone, "--art": art(o), "--fw": `${fw}px`, "--fh": `${h}px` }, ms, wait,
    `<div class="sfx-film-strip"><i class="f f1"></i><i class="f f2"></i><i class="f f3"></i><i class="f f4"></i><i class="f f5"></i></div><div class="sfx-film-text"><small></small><b></b></div>`);
  texts(el, o);
  const d = o.mine ? 1 : -1, span = fw + 16;
  run(el.querySelector(".sfx-film-strip")!, [{ transform: `translateX(${d * (innerWidth / 2 + span * 3)}px)` }, { offset: 0.3, transform: `translateX(${-d * 8}px)` }, { offset: 0.36, transform: "translateX(0)" },
    { offset: 0.78, transform: `translateX(${-d * 10}px)` }, { transform: `translateX(${-d * (innerWidth / 2 + span * 3)}px)` }],
  { duration: ms, delay: wait, easing: "linear", fill: "both" });
  window_(run, el.querySelector(".sfx-film-text")!, ms, wait, 0.32, 0.78);
  return wait + ms * 0.84;
}

/** Ink brush: one wide brush stroke sweeps across, the art inside it, the name in brush lettering. */
export function brush(layer: HTMLElement, run: Run, o: SplashOpts, wait: number, ms: number): number {
  const w = Math.round(Math.min(innerWidth * 0.8, 1180)), h = Math.round(Math.min(innerHeight * (o.big ? 0.36 : 0.3), 320));
  const el = bit(layer, `sfx-g sfx-brush ${o.big ? "is-big" : ""} ${o.mine ? "" : "is-rev"}`, { left: `${(innerWidth - w) / 2}px`, top: `${bandY(o, h)}px`, width: `${w}px`, height: `${h}px`, "--c": o.tone, "--art": art(o) }, ms, wait,
    `<div class="sfx-brush-stroke"><i class="sfx-brush-art"></i></div><div class="sfx-brush-text"><small></small><b></b></div>`);
  texts(el, o);
  const from = o.mine ? "inset(0 100% 0 0)" : "inset(0 0 0 100%)", to = o.mine ? "inset(0 0 0 100%)" : "inset(0 100% 0 0)";
  run(el.querySelector(".sfx-brush-stroke")!, [{ clipPath: from }, { offset: 0.22, clipPath: "inset(0 0 0 0)" }, { offset: 0.8, clipPath: "inset(0 0 0 0)" }, { clipPath: to }],
    { duration: ms, delay: wait, easing: "linear", fill: "both" });
  run(el.querySelector(".sfx-brush-art")!, [{ transform: "scale(1.2) translateX(3%)" }, { transform: "scale(1.08) translateX(-3%)" }], { duration: ms, delay: wait, easing: "linear", fill: "both" });
  window_(run, el.querySelector(".sfx-brush-text")!, ms, wait, 0.2, 0.78, "translateX(-24px)");
  return wait + ms * 0.84;
}

/** The card's rarity on its splash: the name in its lettering (gold, silver, rainbow...), the picture foil as a
 *  sheen sweeping across (holo, gold / platinum metal, prism...), and glitter for the sparkly ones. */
export function foilize(el: HTMLElement, run: Run, rarity: string, wait: number, ms: number) {
  const { lettering, picture } = foilParts(rarity);
  if (lettering !== "none") el.dataset.letter = lettering;
  if (picture === "none") return;
  el.dataset.foil = picture;
  const sheen = document.createElement("i");
  sheen.className = "sfx-foil-sheen";
  el.appendChild(sheen);
  run(sheen, [{ backgroundPosition: "120% 0", opacity: 0 }, { offset: 0.15, opacity: 1 }, { offset: 0.8, opacity: 1 }, { backgroundPosition: "-20% 0", opacity: 0 }], { duration: ms, delay: wait, easing: "linear", fill: "both" });
  if (GLITTER.has(picture)) {
    const g = document.createElement("i");
    g.className = "sfx-foil-glitter";
    el.appendChild(g);
    run(g, [{ opacity: 0 }, { offset: 0.2, opacity: 1 }, { offset: 0.35, opacity: 0.4 }, { offset: 0.5, opacity: 1 }, { offset: 0.65, opacity: 0.5 }, { offset: 0.8, opacity: 1 }, { opacity: 0 }], { duration: ms, delay: wait, easing: "linear", fill: "both" });
  }
}
const GLITTER = new Set(["starlight", "secret", "prism", "rings", "shimmer", "bubbles"]);
