// The card-art splash: the card itself, big, before its summon / activation plays (one function per style).
import { cardImage } from "../../../../api.ts";
import type { SplashStyle } from "../../duelSettings.ts";
import { cancelScheduled } from "../sfx.ts";
import { bit, circleSvg, ctr, sfx, speed } from "./core.ts";
import type { R, Run } from "./core.ts";
import { brush, film, foilize, manga, popart, slash, stamp } from "./splashGraphic.ts";

// ---------------------------------------------------------------------------------------
// the card-art splash: the card itself, big, before its summon / activation plays on the field


/** Splashes don't overlap: each waits for the one before it to be mostly gone. */
let splashFree = 0;
/** Skip: drop the queued splashes and the sounds waiting for them. */
export function resetSplashQueue() { splashFree = 0; cancelScheduled(); }

export interface SplashOpts {
  code: number; name: string; kicker: string; tone: string;
  /** the card's zone on screen: the splash comes out of it and goes back into it */
  at: R;
  /** the middle of the field (screen px) */
  center: { x: number; y: number };
  /** the viewer's own card (the showcase rises on their side of the field) */
  mine: boolean;
  big?: boolean;
  short?: boolean;
  style?: SplashStyle;
  /** the card's rarity (shared/rarity.ts; its board element's data-foil): its foil on the splash */
  rarity?: string;
  /** show "Click or press Space to skip" (the duel; not the lab) */
  skipHint?: boolean;
}
/** The card, big, for a moment. Returns when the board is clear again (ms from now): play the summon /
 *  activation on the field from then. */
export function splash(layer: HTMLElement, run: Run, o: SplashOpts, delay: number): number {
  // the queue runs in real time (speed-adjusted); `wait` is in animation time, which run() scales back
  const now = performance.now();
  // one length per kind of splash (a big card's is larger, not longer)
  const ms = o.short ? 900 : 1250;
  const start = Math.max(now + delay / speed, splashFree);
  const wait = (start - now) * speed;
  splashFree = start + (ms * 0.8) / speed;
  if (o.skipHint) {
    const hint = bit(layer, "sfx-skiphint", {}, ms, wait, "Click or press Space to skip");
    run(hint, [{ opacity: 0 }, { offset: 0.15, opacity: 1 }, { offset: 0.8, opacity: 1 }, { opacity: 0 }], { duration: ms, delay: wait, fill: "both" });
  }
  sfx(o.big ? "splash-big" : "splash", { inMs: wait });
  const style = o.style ?? "showcase";
  const first = layer.childElementCount;
  const done = playStyle(style, layer, run, o, wait, ms);
  // the card's rarity: its lettering on the name, its picture foil over the splash
  if (o.rarity && o.rarity !== "common") for (const el of [...layer.children].slice(first)) if (!el.classList.contains("sfx-skiphint")) foilize(el as HTMLElement, run, o.rarity, wait, ms);
  return done;
}

function playStyle(style: SplashStyle, layer: HTMLElement, run: Run, o: SplashOpts, wait: number, ms: number): number {
  switch (style) {
    case "portal": return portal(layer, run, o, wait, ms);
    case "banner": return banner(layer, run, o, wait, o.short ? 820 : 1150);
    case "cutin": return cutin(layer, run, o, wait, ms);
    case "hologram": return hologram(layer, run, o, wait, ms);
    case "comic": return comic(layer, run, o, wait, ms);
    case "spotlight": return spotlight(layer, run, o, wait, ms);
    case "manga": return manga(layer, run, o, wait, ms);
    case "slash": return slash(layer, run, o, wait, ms);
    case "popart": return popart(layer, run, o, wait, ms);
    case "stamp": return stamp(layer, run, o, wait, ms);
    case "film": return film(layer, run, o, wait, ms);
    case "brush": return brush(layer, run, o, wait, ms);
    default: return showcase(layer, run, o, wait, ms);
  }
}

/** The card's artwork sweeping across the middle of the board in a slanted band, with its name. */
function banner(layer: HTMLElement, run: Run, o: SplashOpts, wait: number, ms: number): number {
  const h = Math.round(Math.min(220, Math.max(110, innerHeight * (o.big ? 0.22 : 0.16))));
  const from = o.mine ? "left" : "right";
  const el = bit(layer, `sfx-splash ${o.big ? "is-big" : ""} from-${from}`, { top: `${o.center.y - h / 2}px`, height: `${h}px`, "--c": o.tone, "--art": `url("${cardImage(o.code, "crop")}")` }, ms, wait,
    `<div class="sfx-splash-art"></div><div class="sfx-splash-shade"></div><div class="sfx-splash-text"><small></small><b></b></div><i class="sfx-splash-edge t"></i><i class="sfx-splash-edge b"></i>`);
  el.querySelector("small")!.textContent = o.kicker;
  el.querySelector("b")!.textContent = o.name;
  const dir = from === "left" ? -1 : 1;
  run(el, [
    // (easing per segment: an easing on the whole animation warps the offsets and the hold ended near half way)
    { transform: `skewY(-5deg) translateX(${dir * 105}%)`, opacity: 0, easing: "cubic-bezier(.2,.8,.3,1)" },
    { offset: 0.16, transform: `skewY(-5deg) translateX(${-dir * 2}%)`, opacity: 1 },
    { offset: 0.24, transform: "skewY(-5deg) translateX(0)", opacity: 1 },
    { offset: 0.8, transform: `skewY(-5deg) translateX(${-dir * 3}%)`, opacity: 1, easing: "ease-in" },
    { transform: `skewY(-5deg) translateX(${-dir * 110}%)`, opacity: 0 },
  ], { duration: ms, delay: wait, easing: "linear", fill: "both" });
  run(el.querySelector(".sfx-splash-art")!, [{ backgroundPosition: `${50 + dir * 8}% 30%` }, { backgroundPosition: `${50 - dir * 8}% 40%` }], { duration: ms, delay: wait, easing: "linear", fill: "both" });
  run(el.querySelector(".sfx-splash-text")!, [{ transform: `translateX(${dir * 60}px)`, opacity: 0 }, { offset: 0.25, transform: `translateX(${dir * 60}px)`, opacity: 0, easing: "ease-out" }, { offset: 0.38, transform: "translateX(0)", opacity: 1 }, { offset: 0.8, opacity: 1 }, { opacity: 0 }],
    { duration: ms, delay: wait, easing: "linear", fill: "both" });
  return wait + ms * 0.66;
}

function showcase(layer: HTMLElement, run: Run, o: SplashOpts, wait: number, ms: number): number {
  const h = Math.round(Math.min(innerHeight * (o.big ? 0.58 : 0.48), o.big ? 640 : 520)), w = Math.round(h * 59 / 86);
  // beside the middle of the field, on the player's side
  const cx = o.center.x + (o.mine ? -1 : 1) * Math.min(innerWidth * 0.17, w * 1.15), cy = o.center.y - h * 0.06;
  const el = bit(layer, `sfx-show ${o.big ? "is-big" : ""}`, { left: `${cx - w / 2}px`, top: `${cy - h / 2}px`, width: `${w}px`, height: `${h}px`, "--c": o.tone }, ms, wait,
    `<div class="sfx-show-glow"></div><div class="sfx-show-rays"></div><div class="sfx-show-card"><img alt="" src="${cardImage(o.code, "full")}"><i class="sfx-show-sheen"></i></div><div class="sfx-show-plate"><small></small><b></b></div>`);
  el.querySelector("small")!.textContent = o.kicker;
  el.querySelector("b")!.textContent = o.name;
  // out of the zone, up, a slow turn, back down into the zone
  const z = ctr(o.at), dx = z.x - cx, dy = z.y - cy, s0 = Math.max(0.12, o.at.height / h);
  const tilt = o.mine ? 1 : -1;
  run(el.querySelector(".sfx-show-card")!, [
    { transform: `translate(${dx}px, ${dy}px) scale(${s0}) rotateY(${70 * tilt}deg)`, opacity: 0.3 },
    { offset: 0.2, transform: `translate(0, -8px) scale(1.04) rotateY(${-10 * tilt}deg)`, opacity: 1 },
    { offset: 0.3, transform: `translate(0, 0) scale(1) rotateY(${-6 * tilt}deg)`, opacity: 1 },
    { offset: 0.72, transform: `translate(0, -6px) scale(1.02) rotateY(${6 * tilt}deg)`, opacity: 1 },
    { transform: `translate(${dx}px, ${dy}px) scale(${s0}) rotateY(0deg)`, opacity: 0 },
  ], { duration: ms, delay: wait, easing: "cubic-bezier(.45,0,.25,1)", fill: "both" });
  run(el.querySelector(".sfx-show-sheen")!, [{ transform: "translateX(-120%) skewX(-18deg)" }, { offset: 0.3, transform: "translateX(-120%) skewX(-18deg)" }, { offset: 0.6, transform: "translateX(320%) skewX(-18deg)" }, { transform: "translateX(320%) skewX(-18deg)" }],
    { duration: ms, delay: wait, easing: "ease-in-out", fill: "both" });
  for (const sel of [".sfx-show-glow", ".sfx-show-rays"]) {
    run(el.querySelector(sel)!, [{ opacity: 0, transform: "scale(.4) rotate(0deg)" }, { offset: 0.25, opacity: 1, transform: "scale(1) rotate(20deg)" }, { offset: 0.7, opacity: 1, transform: "scale(1.05) rotate(70deg)" }, { opacity: 0, transform: "scale(.6) rotate(110deg)" }],
      { duration: ms, delay: wait, easing: "ease-out", fill: "both" });
  }
  run(el.querySelector(".sfx-show-plate")!, [{ opacity: 0, transform: "translate(-50%, 10px)" }, { offset: 0.28, opacity: 0, transform: "translate(-50%, 10px)" }, { offset: 0.38, opacity: 1, transform: "translate(-50%, 0)" }, { offset: 0.72, opacity: 1, transform: "translate(-50%, 0)" }, { opacity: 0, transform: "translate(-50%, 4px)" }],
    { duration: ms, delay: wait, easing: "ease-out", fill: "both" });
  return wait + ms * 0.82;
}

function portal(layer: HTMLElement, run: Run, o: SplashOpts, wait: number, ms: number): number {
  const d = Math.round(Math.min(innerHeight * (o.big ? 0.48 : 0.38), o.big ? 520 : 420));
  const z = ctr(o.at);
  // centred on the zone, kept on screen
  const cx = Math.min(innerWidth - d / 2 - 12, Math.max(d / 2 + 12, z.x)), cy = Math.min(innerHeight - d / 2 - 60, Math.max(d / 2 + 12, z.y));
  const el = bit(layer, `sfx-portal ${o.big ? "is-big" : ""}`, { left: `${cx - d / 2}px`, top: `${cy - d / 2}px`, width: `${d}px`, height: `${d}px`, "--c": o.tone, "--art": `url("${cardImage(o.code, "crop")}")` }, ms, wait,
    `<div class="sfx-portal-art"></div><div class="sfx-portal-ring">${circleSvg(8)}</div><div class="sfx-portal-plate"><small></small><b></b></div>`);
  el.querySelector("small")!.textContent = o.kicker;
  el.querySelector("b")!.textContent = o.name;
  run(el.querySelector(".sfx-portal-art")!, [
    { clipPath: "circle(0% at 50% 50%)", transform: "scale(1.25)" },
    { offset: 0.25, clipPath: "circle(46% at 50% 50%)", transform: "scale(1.08)" },
    { offset: 0.75, clipPath: "circle(46% at 50% 50%)", transform: "scale(1)" },
    { clipPath: "circle(0% at 50% 50%)", transform: "scale(.96)" },
  ], { duration: ms, delay: wait, easing: "cubic-bezier(.5,0,.3,1)", fill: "both" });
  run(el.querySelector(".sfx-portal-ring")!, [{ transform: "rotate(-90deg) scale(.2)", opacity: 0 }, { offset: 0.25, transform: "rotate(0deg) scale(1)", opacity: 1 }, { offset: 0.75, transform: "rotate(60deg) scale(1)", opacity: 1 }, { transform: "rotate(120deg) scale(.15)", opacity: 0 }],
    { duration: ms, delay: wait, easing: "cubic-bezier(.5,0,.3,1)", fill: "both" });
  run(el.querySelector(".sfx-portal-plate")!, [{ opacity: 0, transform: "translate(-50%, 8px)" }, { offset: 0.25, opacity: 0, transform: "translate(-50%, 8px)" }, { offset: 0.35, opacity: 1, transform: "translate(-50%, 0)" }, { offset: 0.72, opacity: 1, transform: "translate(-50%, 0)" }, { opacity: 0, transform: "translate(-50%, 0)" }],
    { duration: ms, delay: wait, easing: "ease-out", fill: "both" });
  return wait + ms * 0.85;
}

/** A framed, slanted panel of the art bursting in from the screen edge on the owner's side (a fighting-game cut-in). */
function cutin(layer: HTMLElement, run: Run, o: SplashOpts, wait: number, ms: number): number {
  const w = Math.round(Math.min(innerWidth * 0.46, 760)), h = Math.round(Math.min(innerHeight * (o.big ? 0.3 : 0.24), 300));
  const left = o.mine;
  const y = Math.min(innerHeight - h - 20, Math.max(20, ctr(o.at).y - h / 2));
  const el = bit(layer, `sfx-cutin ${left ? "from-left" : "from-right"} ${o.big ? "is-big" : ""}`, { top: `${y}px`, width: `${w}px`, height: `${h}px`, [left ? "left" : "right"]: "0px", "--c": o.tone, "--art": `url("${cardImage(o.code, "crop")}")` }, ms, wait,
    `<i class="sfx-cutin-lines"></i><div class="sfx-cutin-frame"><div class="sfx-cutin-art"></div></div><div class="sfx-cutin-text"><small></small><b></b></div>`);
  el.querySelector("small")!.textContent = o.kicker;
  el.querySelector("b")!.textContent = o.name;
  const d = left ? -1 : 1;
  run(el, [{ transform: `translateX(${d * 110}%)` }, { offset: 0.14, transform: `translateX(${-d * 3}%)` }, { offset: 0.2, transform: "translateX(0)" }, { offset: 0.8, transform: `translateX(${-d * 1.5}%)` }, { transform: `translateX(${d * 110}%)` }],
    { duration: ms, delay: wait, easing: "cubic-bezier(.2,.8,.3,1)", fill: "both" });
  run(el.querySelector(".sfx-cutin-art")!, [{ transform: "scale(1.25) translateX(4%)" }, { transform: "scale(1.1) translateX(-4%)" }], { duration: ms, delay: wait, easing: "linear", fill: "both" });
  run(el.querySelector(".sfx-cutin-lines")!, [{ transform: "translateX(0)", opacity: 0 }, { offset: 0.15, opacity: 1 }, { offset: 0.85, opacity: 1 }, { transform: `translateX(${-d * 120}px)`, opacity: 0 }], { duration: ms, delay: wait, easing: "linear", fill: "both" });
  return wait + ms * 0.85;
}

/** A projector beam from the card and the card above it as a flickering hologram. */
function hologram(layer: HTMLElement, run: Run, o: SplashOpts, wait: number, ms: number): number {
  const h = Math.round(Math.min(innerHeight * (o.big ? 0.48 : 0.4), 460)), w = Math.round(h * 59 / 86);
  const z = ctr(o.at);
  const cx = Math.min(innerWidth - w / 2 - 16, Math.max(w / 2 + 16, z.x));
  const top = Math.max(12, Math.min(o.at.top - h * 0.85, innerHeight - h - 70));
  const el = bit(layer, `sfx-holo ${o.big ? "is-big" : ""}`, { left: `${cx - w / 2}px`, top: `${top}px`, width: `${w}px`, height: `${h}px`, "--c": o.tone }, ms, wait,
    `<div class="sfx-holo-card"><img alt="" src="${cardImage(o.code, "full")}"><i class="sfx-holo-scan"></i></div><div class="sfx-holo-text"><small></small><b></b></div>`);
  el.querySelector("small")!.textContent = o.kicker;
  el.querySelector("b")!.textContent = o.name;
  // the beam: from the card up to the hologram's bottom edge
  const beamTop = top + h * 0.9, beamH = Math.max(20, z.y - beamTop);
  const beam = bit(layer, "sfx-holo-beam", { left: `${cx - w * 0.6}px`, top: `${beamTop}px`, width: `${w * 1.2}px`, height: `${beamH}px`, "--c": o.tone, "--base": `${Math.max(8, (o.at.width / (w * 1.2)) * 50)}%` }, ms, wait);
  run(beam, [{ opacity: 0, transform: "scaleY(0)" }, { offset: 0.15, opacity: 1, transform: "scaleY(1)" }, { offset: 0.8, opacity: 0.9 }, { opacity: 0, transform: "scaleY(.2)" }], { duration: ms, delay: wait, easing: "ease-out", fill: "both" });
  run(el.querySelector(".sfx-holo-card")!, [
    { opacity: 0, transform: "translateY(30%) scaleY(.05)" }, { offset: 0.18, opacity: 0.9, transform: "translateY(0) scaleY(1)" },
    { offset: 0.3, opacity: 0.55 }, { offset: 0.33, opacity: 0.9 }, { offset: 0.6, opacity: 0.85 }, { offset: 0.62, opacity: 0.5 }, { offset: 0.65, opacity: 0.9 },
    { offset: 0.82, opacity: 0.9, transform: "translateY(0) scaleY(1)" }, { opacity: 0, transform: "translateY(40%) scaleY(.02)" },
  ], { duration: ms, delay: wait, easing: "ease-in-out", fill: "both" });
  run(el.querySelector(".sfx-holo-scan")!, [{ transform: "translateY(-100%)" }, { transform: "translateY(100%)" }], { duration: 700, delay: wait, iterations: Math.ceil(ms / 700), easing: "linear", fill: "both" });
  run(el.querySelector(".sfx-holo-text")!, [{ opacity: 0 }, { offset: 0.25, opacity: 0 }, { offset: 0.35, opacity: 1 }, { offset: 0.78, opacity: 1 }, { opacity: 0 }], { duration: ms, delay: wait, fill: "both" });
  return wait + ms * 0.85;
}

/** A comic-book starburst next to the card: halftone, the art in a tilted frame, the name in bold outline. */
function comic(layer: HTMLElement, run: Run, o: SplashOpts, wait: number, ms: number): number {
  const s = Math.round(Math.min(innerHeight * (o.big ? 0.56 : 0.46), 520));
  const z = ctr(o.at);
  const side = o.mine ? 1 : -1;
  const cx = Math.min(innerWidth - s / 2 - 8, Math.max(s / 2 + 8, z.x + side * s * 0.55)), cy = Math.min(innerHeight - s / 2 - 8, Math.max(s / 2 + 8, z.y - s * 0.25));
  const el = bit(layer, `sfx-comic ${o.big ? "is-big" : ""}`, { left: `${cx - s / 2}px`, top: `${cy - s / 2}px`, width: `${s}px`, height: `${s}px`, "--c": o.tone, "--art": `url("${cardImage(o.code, "crop")}")` }, ms, wait,
    `<div class="sfx-comic-burst"></div><div class="sfx-comic-frame"><div class="sfx-comic-art"></div></div><div class="sfx-comic-text"><small></small><b></b></div>`);
  el.querySelector("small")!.textContent = o.kicker;
  el.querySelector("b")!.textContent = o.name;
  // easing per keyframe, the effect linear (whole-effect easing would move the 0.8 hold point earlier)
  run(el, [{ transform: "scale(0) rotate(-20deg)", opacity: 0, easing: "ease-out" }, { offset: 0.12, transform: "scale(1.15) rotate(4deg)", opacity: 1, easing: "ease-out" }, { offset: 0.18, transform: "scale(.96) rotate(-2deg)", easing: "ease-out" },
    { offset: 0.24, transform: "scale(1) rotate(0deg)" }, { offset: 0.8, transform: "scale(1.02) rotate(1deg)", opacity: 1, easing: "ease-in" }, { transform: "scale(.2) rotate(15deg)", opacity: 0 }],
    { duration: ms, delay: wait, easing: "linear", fill: "both" });
  run(el.querySelector(".sfx-comic-burst")!, [{ transform: "rotate(0deg)" }, { transform: "rotate(25deg)" }], { duration: ms, delay: wait, easing: "linear", fill: "both" });
  return wait + ms * 0.82;
}

/** The screen dims, a cone of light falls on the card, and the card rises into it. */
function spotlight(layer: HTMLElement, run: Run, o: SplashOpts, wait: number, ms: number): number {
  const z = ctr(o.at);
  const h = Math.round(Math.min(innerHeight * (o.big ? 0.5 : 0.42), 480)), w = Math.round(h * 59 / 86);
  const cx = Math.min(innerWidth - w / 2 - 16, Math.max(w / 2 + 16, z.x)), cy = Math.min(innerHeight - h / 2 - 70, Math.max(h / 2 + 16, z.y - h * 0.35));
  const dim = bit(layer, "sfx-spot-dim", { "--x": `${cx}px`, "--y": `${cy}px`, "--r": `${h * 0.75}px` }, ms, wait);
  run(dim, [{ opacity: 0 }, { offset: 0.15, opacity: 1 }, { offset: 0.8, opacity: 1 }, { opacity: 0 }], { duration: ms, delay: wait, fill: "both" });
  const cone = bit(layer, "sfx-spot-cone", { left: `${cx - w * 1.1}px`, top: "0px", width: `${w * 2.2}px`, height: `${cy + h * 0.55}px`, "--c": o.tone }, ms, wait);
  run(cone, [{ opacity: 0, transform: "scaleX(.2)" }, { offset: 0.18, opacity: 1, transform: "scaleX(1)" }, { offset: 0.8, opacity: 1 }, { opacity: 0 }], { duration: ms, delay: wait, easing: "ease-out", fill: "both" });
  const el = bit(layer, `sfx-spot ${o.big ? "is-big" : ""}`, { left: `${cx - w / 2}px`, top: `${cy - h / 2}px`, width: `${w}px`, height: `${h}px`, "--c": o.tone }, ms, wait,
    `<div class="sfx-spot-card"><img alt="" src="${cardImage(o.code, "full")}"></div><div class="sfx-spot-text"><small></small><b></b></div>`);
  el.querySelector("small")!.textContent = o.kicker;
  el.querySelector("b")!.textContent = o.name;
  const dy = z.y - cy, s0 = Math.max(0.15, o.at.height / h);
  run(el.querySelector(".sfx-spot-card")!, [{ transform: `translateY(${dy}px) scale(${s0})`, opacity: 0, filter: "brightness(2.2)" }, { offset: 0.25, transform: "translateY(0) scale(1)", opacity: 1, filter: "brightness(1.3)" },
    { offset: 0.4, filter: "brightness(1)" }, { offset: 0.8, transform: "translateY(-6px) scale(1.02)", opacity: 1 }, { transform: `translateY(${dy}px) scale(${s0})`, opacity: 0 }],
    { duration: ms, delay: wait, easing: "cubic-bezier(.3,.6,.3,1)", fill: "both" });
  run(el.querySelector(".sfx-spot-text")!, [{ opacity: 0, transform: "translate(-50%, 8px)" }, { offset: 0.3, opacity: 0, transform: "translate(-50%, 8px)" }, { offset: 0.4, opacity: 1, transform: "translate(-50%, 0)" }, { offset: 0.78, opacity: 1, transform: "translate(-50%, 0)" }, { opacity: 0, transform: "translate(-50%, 0)" }],
    { duration: ms, delay: wait, easing: "ease-out", fill: "both" });
  return wait + ms * 0.85;
}
