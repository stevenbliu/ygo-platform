// Visual effects drawn in the animation layer (a fixed, pointer-events:none overlay): card
// shatter / dissolve / light pillar / sparkle trail, category flourishes (vortex, pit, negate
// stamp, fireball, hand-trap slam, ring) and attribute + type themed attacks.
// Everything is transform / opacity keyframes on short-lived elements that remove themselves.
// Colours come from CSS classes (duel.css) built on theme tokens.

import { cardImage } from "../../../api.ts";
import { CARD_BACK_SVG } from "../cardBack.ts";
import type { AttackElement, AttackShape } from "./categories.ts";

type Pt = { x: number; y: number };
type Run = (el: Element, frames: Keyframe[], opts: KeyframeAnimationOptions) => Animation;

export const center = (r: DOMRect): Pt => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

/** A card-shaped element (face or back) at `rect`. */
export function cardEl(code: number, faceUp: boolean, rect: { left: number; top: number; width: number; height: number }, extra = ""): HTMLDivElement {
  const g = document.createElement("div");
  g.className = `duel-card duel-ghost ${extra}`;
  Object.assign(g.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
  const inner = document.createElement("div");
  inner.className = "duel-card-inner";
  if (faceUp && code > 0) {
    const face = document.createElement("div");
    face.className = "duel-card-face";
    const img = document.createElement("img");
    img.src = cardImage(code, "small");
    img.alt = "";
    face.appendChild(img);
    inner.appendChild(face);
  } else {
    const back = document.createElement("div");
    back.className = "duel-card-back";
    back.innerHTML = CARD_BACK_SVG;
    inner.appendChild(back);
  }
  g.appendChild(inner);
  return g;
}

/** A plain effect element, removed after `ms` (+ delay). */
function bit(layer: HTMLElement, cls: string, style: Partial<CSSStyleDeclaration>, ms: number, delay: number): HTMLDivElement {
  const el = document.createElement("div");
  el.className = `duel-fx ${cls}`;
  Object.assign(el.style, style);
  layer.appendChild(el);
  setTimeout(() => el.remove(), ms + delay + 400);
  return el;
}
const box = (r: { left: number; top: number; width: number; height: number }) => ({ left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });

// ---------------------------------------------------------------------------------------
// how cards leave / arrive

/** The card breaks into shards that fly apart (destroyed). */
export function shatter(layer: HTMLElement, run: Run, rect: DOMRect, code: number, faceUp: boolean, delay: number) {
  const pieces = [
    "polygon(0 0, 55% 0, 40% 38%, 0 30%)", "polygon(55% 0, 100% 0, 100% 35%, 40% 38%)", "polygon(0 30%, 40% 38%, 30% 70%, 0 64%)",
    "polygon(40% 38%, 100% 35%, 100% 68%, 62% 60%, 30% 70%)", "polygon(0 64%, 30% 70%, 45% 100%, 0 100%)", "polygon(30% 70%, 62% 60%, 100% 68%, 100% 100%, 45% 100%)",
  ];
  const dirs = [[-1, -1], [1, -1], [-1, 0], [1, 0.1], [-0.6, 1], [0.8, 1]];
  bit(layer, "fx-crack", box(rect), 420, delay);
  pieces.forEach((clip, i) => {
    const s = cardEl(code, faceUp, rect, "fx-shard");
    s.style.clipPath = clip;
    layer.appendChild(s);
    const [dx, dy] = dirs[i];
    const a = run(s, [
      { transform: "none", opacity: 1 },
      { offset: 0.25, transform: `translate(${dx * 3}px, ${dy * 3}px)`, opacity: 1 },
      { transform: `translate(${dx * rect.width * 0.9}px, ${dy * rect.height * 0.6 + 18}px) rotate(${dx * 40}deg) scale(.7)`, opacity: 0 },
    ], { duration: 520, delay: delay + 60, easing: "cubic-bezier(.2,.6,.4,1)", fill: "both" });
    a.onfinish = () => s.remove();
    setTimeout(() => s.remove(), delay + 1200);
  });
}

/** The card dissolves into violet void motes (banished). */
export function dissolve(layer: HTMLElement, run: Run, rect: DOMRect, code: number, faceUp: boolean, delay: number) {
  const g = cardEl(code, faceUp, rect, "fx-dissolve");
  layer.appendChild(g);
  const a = run(g, [{ opacity: 1, filter: "none", transform: "none" }, { opacity: 0, filter: "blur(4px) saturate(0)", transform: "scale(.9) translateY(-6px)" }],
    { duration: 520, delay, easing: "ease-in", fill: "both" });
  a.onfinish = () => g.remove();
  setTimeout(() => g.remove(), delay + 1200);
  const c = center(rect);
  for (let i = 0; i < 10; i++) {
    const m = bit(layer, "fx-mote", { left: `${c.x + (Math.random() - 0.5) * rect.width}px`, top: `${c.y + (Math.random() - 0.5) * rect.height}px` }, 700, delay);
    run(m, [{ transform: "scale(.4)", opacity: 0 }, { offset: 0.3, opacity: 1 }, { transform: `translate(${(Math.random() - 0.5) * 30}px, ${-24 - Math.random() * 30}px) scale(1)`, opacity: 0 }],
      { duration: 700, delay: delay + i * 25, easing: "ease-out", fill: "both" });
  }
}

/** A column of light at a zone (revived from the GY / banishment). */
export function pillar(layer: HTMLElement, run: Run, rect: DOMRect, delay: number) {
  const w = rect.width * 0.9;
  const p = bit(layer, "fx-pillar", { left: `${rect.left + rect.width / 2 - w / 2}px`, top: `${rect.top - rect.height * 1.6}px`, width: `${w}px`, height: `${rect.height * 2.6}px` }, 700, delay);
  run(p, [{ transform: "scaleY(0)", opacity: 0 }, { offset: 0.3, transform: "scaleY(1)", opacity: 1 }, { transform: "scaleY(1) scaleX(.2)", opacity: 0 }],
    { duration: 700, delay, easing: "ease-out", fill: "both" });
}

/** A trail of sparkles from -> to (searched / drawn by an effect). */
export function sparkle(layer: HTMLElement, run: Run, from: DOMRect, to: DOMRect, delay: number) {
  const a = center(from), b = center(to);
  for (let i = 0; i < 7; i++) {
    const k = i / 6;
    const s = bit(layer, "fx-star", { left: `${a.x + (b.x - a.x) * k}px`, top: `${a.y + (b.y - a.y) * k - Math.sin(k * Math.PI) * 30}px` }, 600, delay);
    run(s, [{ transform: "scale(0) rotate(0)", opacity: 0 }, { offset: 0.4, transform: "scale(1) rotate(45deg)", opacity: 1 }, { transform: "scale(.2) rotate(90deg)", opacity: 0 }],
      { duration: 520, delay: delay + i * 45, easing: "ease-out", fill: "both" });
  }
}

/** Speed lines as a card is bounced. */
export function whoosh(layer: HTMLElement, run: Run, rect: DOMRect, delay: number) {
  const w = bit(layer, "fx-whoosh", box(rect), 380, delay);
  run(w, [{ opacity: 0, transform: "scaleX(.4)" }, { offset: 0.3, opacity: 1 }, { opacity: 0, transform: "scaleX(1.4)" }], { duration: 380, delay, fill: "both" });
}

// ---------------------------------------------------------------------------------------
// category flourishes

/** Dark vortex with lightning sweeping a field (board wipe). */
export function vortex(layer: HTMLElement, run: Run, area: DOMRect, delay: number) {
  const size = Math.max(area.width, area.height) * 0.9;
  const c = center(area);
  const v = bit(layer, "fx-vortex", { left: `${c.x - size / 2}px`, top: `${c.y - size / 2}px`, width: `${size}px`, height: `${size}px` }, 900, delay);
  run(v, [{ transform: "scale(.2) rotate(0)", opacity: 0 }, { offset: 0.35, transform: "scale(1) rotate(200deg)", opacity: 0.9 }, { transform: "scale(1.15) rotate(420deg)", opacity: 0 }],
    { duration: 900, delay, easing: "ease-in-out", fill: "both" });
  const bolt = bit(layer, "fx-bolt", { left: `${area.left}px`, top: `${c.y - 3}px`, width: `${area.width}px` }, 500, delay + 250);
  run(bolt, [{ transform: "scaleX(0)", opacity: 1, transformOrigin: "left" }, { offset: 0.5, transform: "scaleX(1)", opacity: 1 }, { transform: "scaleX(1)", opacity: 0 }],
    { duration: 450, delay: delay + 250, easing: "ease-out", fill: "both" });
}

/** A pit with spikes opens under a card (Trap Hole family). */
export function pit(layer: HTMLElement, run: Run, rect: DOMRect, delay: number) {
  const w = rect.width * 1.5, h = rect.width * 0.55;
  const p = bit(layer, "fx-pit", { left: `${rect.left + rect.width / 2 - w / 2}px`, top: `${rect.top + rect.height - h / 2}px`, width: `${w}px`, height: `${h}px` }, 800, delay);
  run(p, [{ transform: "scale(0)", opacity: 0 }, { offset: 0.25, transform: "scale(1)", opacity: 1 }, { offset: 0.75, transform: "scale(1)", opacity: 1 }, { transform: "scale(.6)", opacity: 0 }],
    { duration: 800, delay, easing: "ease-out", fill: "both" });
}

/** A red seal slams onto a negated card / chain link. */
export function stamp(layer: HTMLElement, run: Run, rect: DOMRect, delay: number) {
  const s = Math.max(rect.width, rect.height) * 0.8;
  const c = center(rect);
  const el = bit(layer, "fx-stamp", { left: `${c.x - s / 2}px`, top: `${c.y - s / 2}px`, width: `${s}px`, height: `${s}px` }, 900, delay);
  run(el, [{ transform: "scale(2.4) rotate(-25deg)", opacity: 0 }, { offset: 0.25, transform: "scale(1) rotate(-12deg)", opacity: 1 }, { offset: 0.8, transform: "scale(1) rotate(-12deg)", opacity: 1 }, { transform: "scale(1.05) rotate(-12deg)", opacity: 0 }],
    { duration: 900, delay, easing: "cubic-bezier(.3,1.4,.5,1)", fill: "both" });
}

/** A fireball flies from a card to a player's LP plate (burn). */
export function fireball(layer: HTMLElement, run: Run, from: DOMRect, to: DOMRect, delay: number) {
  const a = center(from), b = center(to);
  const f = bit(layer, "fx-fireball", { left: `${a.x - 12}px`, top: `${a.y - 12}px` }, 700, delay);
  run(f, [{ transform: "translate(0,0) scale(.5)", opacity: 0 }, { offset: 0.15, transform: "translate(0,0) scale(1)", opacity: 1 },
    { offset: 0.85, transform: `translate(${b.x - a.x}px, ${b.y - a.y}px) scale(1.2)`, opacity: 1 }, { transform: `translate(${b.x - a.x}px, ${b.y - a.y}px) scale(2.4)`, opacity: 0 }],
    { duration: 650, delay, easing: "cubic-bezier(.5,0,.7,1)", fill: "both" });
  impact(layer, run, to, "fire", delay + 560);
}

/** Expanding ring around a card (generic activation / search / revive). */
export function ring(layer: HTMLElement, run: Run, rect: DOMRect, delay: number, tone = "") {
  const s = Math.max(rect.width, rect.height) * 1.1;
  const c = center(rect);
  const el = bit(layer, `fx-ring ${tone}`, { left: `${c.x - s / 2}px`, top: `${c.y - s / 2}px`, width: `${s}px`, height: `${s}px` }, 600, delay);
  run(el, [{ transform: "scale(.4)", opacity: 0 }, { offset: 0.3, opacity: 1 }, { transform: "scale(1.5)", opacity: 0 }], { duration: 600, delay, easing: "ease-out", fill: "both" });
}

// ---------------------------------------------------------------------------------------
// attacks: attribute = colour/particles, type = shape

export function impact(layer: HTMLElement, run: Run, rect: DOMRect, element: AttackElement, delay: number) {
  const s = Math.max(rect.width, rect.height) * 0.9;
  const c = center(rect);
  const el = bit(layer, `fx-impact el-${element}`, { left: `${c.x - s / 2}px`, top: `${c.y - s / 2}px`, width: `${s}px`, height: `${s}px` }, 420, delay);
  run(el, [{ transform: "scale(.2)", opacity: 0 }, { offset: 0.3, transform: "scale(1)", opacity: 1 }, { transform: "scale(1.4)", opacity: 0 }], { duration: 420, delay, easing: "ease-out", fill: "both" });
}

/** The attack's projectile / strike from the attacker (`a`) to the target (`b`). Returns ms until impact. */
export function strike(layer: HTMLElement, run: Run, a: DOMRect, b: DOMRect, element: AttackElement, shape: AttackShape, delay: number): number {
  const p = center(a), q = center(b);
  const dx = q.x - p.x, dy = q.y - p.y, len = Math.hypot(dx, dy), ang = Math.atan2(dy, dx) * 180 / Math.PI;
  const cls = `el-${element}`;
  switch (shape) {
    case "breath": case "laser": {
      const thick = shape === "breath" ? Math.max(14, a.width * 0.35) : 5;
      const beam = bit(layer, `fx-beam fx-${shape} ${cls}`, { left: `${p.x}px`, top: `${p.y - thick / 2}px`, width: `${len}px`, height: `${thick}px`, transform: `rotate(${ang}deg)`, transformOrigin: "0 50%" }, 520, delay);
      run(beam, [{ transform: `rotate(${ang}deg) scaleX(0)`, opacity: 1 }, { offset: 0.45, transform: `rotate(${ang}deg) scaleX(1)`, opacity: 1 }, { transform: `rotate(${ang}deg) scaleX(1) scaleY(.2)`, opacity: 0 }],
        { duration: 520, delay, easing: "ease-out", fill: "both" });
      return 230;
    }
    case "orb": {
      const o = bit(layer, `fx-orb ${cls}`, { left: `${p.x - 13}px`, top: `${p.y - 13}px` }, 520, delay);
      run(o, [{ transform: "translate(0,0) scale(.3)", opacity: 0 }, { offset: 0.2, transform: "translate(0,0) scale(1)", opacity: 1 },
        { offset: 0.85, transform: `translate(${dx}px, ${dy}px) scale(1)`, opacity: 1 }, { transform: `translate(${dx}px, ${dy}px) scale(1.8)`, opacity: 0 }],
        { duration: 520, delay, easing: "cubic-bezier(.4,0,.6,1)", fill: "both" });
      return 440;
    }
    case "slash": case "claw": {
      const n = shape === "claw" ? 3 : 1;
      const w = b.width * 1.5;
      for (let i = 0; i < n; i++) {
        const off = (i - (n - 1) / 2) * b.width * 0.25;
        const s = bit(layer, `fx-slash fx-${shape} ${cls}`, { left: `${q.x - w / 2 + off}px`, top: `${q.y - 3}px`, width: `${w}px` }, 420, delay + 200);
        run(s, [{ transform: `rotate(${shape === "claw" ? 70 : -35}deg) scaleX(0)`, opacity: 1 }, { offset: 0.5, transform: `rotate(${shape === "claw" ? 70 : -35}deg) scaleX(1)`, opacity: 1 }, { transform: `rotate(${shape === "claw" ? 70 : -35}deg) scaleX(1)`, opacity: 0 }],
          { duration: 360, delay: delay + 200 + i * 50, easing: "ease-out", fill: "both" });
      }
      return 260;
    }
    default: {   // pounce / lunge: a burst of the element on the attacker as it leaps
      const t = bit(layer, `fx-trail ${cls}`, box(a), 440, delay);
      run(t, [{ transform: "none", opacity: 0.8 }, { transform: `translate(${dx * 0.7}px, ${dy * 0.7}px) scale(${shape === "pounce" ? 1.3 : 1})`, opacity: 0 }], { duration: 440, delay, easing: "ease-in", fill: "both" });
      return 220;
    }
  }
}

/** Released as a Tribute: a golden glow, the card rises and fades upward. */
export function ascend(layer: HTMLElement, run: Run, rect: DOMRect, code: number, faceUp: boolean, delay: number) {
  const g = cardEl(code, faceUp, rect, "fx-tribute");
  layer.appendChild(g);
  const a = run(g, [
    { transform: "none", opacity: 1, filter: "brightness(1)" },
    { offset: 0.3, transform: "scale(1.06)", opacity: 1, filter: "brightness(1.6) drop-shadow(0 0 12px #ffd76a)" },
    { transform: `translateY(${-rect.height * 0.9}px) scale(.82)`, opacity: 0, filter: "brightness(2) drop-shadow(0 0 18px #ffd76a)" },
  ], { duration: 760, delay, easing: "cubic-bezier(.3,.5,.3,1)", fill: "both" });
  a.onfinish = () => g.remove();
  setTimeout(() => g.remove(), delay + 1500);
  ring(layer, run, rect, delay + 80, "tone-light");
}

/** Used as material: the card flies into the monster it becomes, shrinking into a spark. */
export function converge(layer: HTMLElement, run: Run, from: DOMRect, into: DOMRect, code: number, faceUp: boolean, delay: number) {
  const g = cardEl(code, faceUp, from, "fx-material");
  layer.appendChild(g);
  const dx = into.left + into.width / 2 - (from.left + from.width / 2), dy = into.top + into.height / 2 - (from.top + from.height / 2);
  const a = run(g, [
    { transform: "none", opacity: 1, filter: "brightness(1)" },
    { offset: 0.35, transform: `translate(${dx * 0.15}px, ${dy * 0.15 - 14}px) scale(1.04)`, opacity: 1, filter: "brightness(1.5) drop-shadow(0 0 10px #c9b8ff)" },
    { transform: `translate(${dx}px, ${dy}px) scale(.25) rotate(160deg)`, opacity: 0, filter: "brightness(2.2) drop-shadow(0 0 16px #c9b8ff)" },
  ], { duration: 640, delay, easing: "cubic-bezier(.5,0,.6,1)", fill: "both" });
  a.onfinish = () => g.remove();
  setTimeout(() => g.remove(), delay + 1400);
}

/** Sent to the GY (or milled): the card lifts, arcs over to the pile and lands; a mill flips face-up on the way. */
export function arcTo(layer: HTMLElement, run: Run, from: DOMRect, to: DOMRect, code: number, faceUp: boolean, delay: number, flipFirst: boolean) {
  const g = cardEl(code, faceUp, from, flipFirst ? "fx-mill" : "fx-send");
  layer.appendChild(g);
  const dx = to.left + to.width / 2 - (from.left + from.width / 2), dy = to.top + to.height / 2 - (from.top + from.height / 2);
  const s = Math.min(1.2, Math.max(0.6, (Math.min(to.width, to.height * (59 / 86)) || from.width) / from.width));
  const lift = -Math.max(30, Math.abs(dx) * 0.25);
  const a = run(g, [
    { transform: flipFirst ? "scaleX(0.05)" : "none", opacity: 1 },
    { offset: flipFirst ? 0.18 : 0.12, transform: `translate(0, ${lift * 0.4}px) scale(1.08)`, opacity: 1 },
    { offset: 0.55, transform: `translate(${dx * 0.55}px, ${dy * 0.55 + lift}px) rotate(${dx > 0 ? 8 : -8}deg) scale(${(1 + s) / 2})`, opacity: 1 },
    { offset: 0.9, transform: `translate(${dx}px, ${dy}px) scale(${s})`, opacity: 1 },
    { transform: `translate(${dx}px, ${dy}px) scale(${s})`, opacity: 0 },
  ], { duration: flipFirst ? 620 : 560, delay, easing: "cubic-bezier(.35,.6,.35,1)", fill: "both" });
  a.onfinish = () => g.remove();
  setTimeout(() => g.remove(), delay + 1500);
}

/** Drawing a card: it slides off the top of the Deck, lifts, arcs over to its place in the hand and settles there.
 *  Your own draws turn face-up on the way (a 3D flip) and catch a glint of light; the opponent's stay face-down.
 *  The real hand card stays hidden until the flight lands (the animator fades it in). */
export const DRAW_MS = 700;
/** `sleeve`: the Deck's own card back (the player's sleeve), copied onto the card's back face. */
export function draw(layer: HTMLElement, run: Run, from: DOMRect, to: DOMRect, code: number, faceUp: boolean, delay: number, sleeve?: Element | null) {
  if (!from.width || !from.height) return;
  // card proportions, centred on the Deck (a tilted pile's on-screen box is squarer than a card)
  const w = Math.min(from.width, from.height * (59 / 86)), h = w * (86 / 59);
  const left = from.left + (from.width - w) / 2, top = from.top + (from.height - h) / 2;
  const g = document.createElement("div");
  g.className = "fx-draw";
  Object.assign(g.style, { left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${h}px` });
  const inner = document.createElement("div");
  inner.className = "fx-draw-inner";
  const box = { left: 0, top: 0, width: w, height: h };
  const backFace = cardEl(0, false, box, "fx-draw-face fx-draw-back");
  const plain = backFace.querySelector(".duel-card-back");
  if (sleeve && plain) plain.replaceWith(sleeve.cloneNode(true));
  inner.appendChild(backFace);
  if (faceUp) {
    const front = cardEl(code, true, box, "fx-draw-face fx-draw-front");
    const glint = document.createElement("i");
    glint.className = "fx-draw-glint";
    front.appendChild(glint);
    inner.appendChild(front);
    run(glint, [{ transform: "translateX(-120%) skewX(-18deg)", opacity: 0 }, { offset: 0.6, transform: "translateX(-120%) skewX(-18deg)", opacity: 0 },
      { offset: 0.7, opacity: 1 }, { transform: "translateX(160%) skewX(-18deg)", opacity: 0 }], { duration: DRAW_MS, delay, easing: "ease-out", fill: "both" });
  }
  g.appendChild(inner);
  layer.appendChild(g);
  const dx = to.left + to.width / 2 - (left + w / 2), dy = to.top + to.height / 2 - (top + h / 2);
  const s = Math.max(0.5, Math.min(2.2, Math.min(to.width, to.height * (59 / 86)) / w));
  const lift = -h * 0.5, tilt = dx > 0 ? 7 : -7;
  const a = run(g, [
    { transform: "none", opacity: 1 },
    { offset: 0.2, transform: `translate(${dx * 0.04}px, ${lift * 0.8}px) scale(1.12) rotate(${-tilt / 2}deg)`, opacity: 1 },
    { offset: 0.62, transform: `translate(${dx * 0.68}px, ${dy * 0.68 + lift}px) scale(${(1 + s) / 2 * 1.12}) rotate(${tilt}deg)`, opacity: 1 },
    { offset: 0.88, transform: `translate(${dx}px, ${dy - h * 0.06}px) scale(${s * 1.04}) rotate(0deg)`, opacity: 1 },
    { transform: `translate(${dx}px, ${dy}px) scale(${s})`, opacity: 1 },
  ], { duration: DRAW_MS, delay, easing: "cubic-bezier(.3,.55,.25,1)", fill: "both" });
  if (faceUp) run(inner, [{ transform: "rotateY(0deg)" }, { offset: 0.22, transform: "rotateY(0deg)" }, { offset: 0.62, transform: "rotateY(180deg)" }, { transform: "rotateY(180deg)" }],
    { duration: DRAW_MS, delay, easing: "ease-in-out", fill: "both" });
  const done = () => g.remove();
  a.onfinish = done;
  a.oncancel = done;
  setTimeout(done, DRAW_MS + delay + 1500);
}

/** Excavate: the top cards lift off the Deck, fan out face-up above it, hold, then sink back. */
export function fan(layer: HTMLElement, run: Run, deck: DOMRect, codes: number[], delay: number) {
  const n = Math.min(codes.length, 6);
  const spread = Math.min(deck.width * 0.85, 520 / Math.max(1, n));
  codes.slice(0, n).forEach((code, i) => {
    const g = cardEl(code, true, deck, "fx-excavate");
    layer.appendChild(g);
    const off = (i - (n - 1) / 2) * spread;
    const up = -deck.height * 1.05;
    const a = run(g, [
      { transform: "scaleX(.05)", opacity: 0 },
      { offset: 0.18, transform: `translate(${off}px, ${up}px) rotate(${(i - (n - 1) / 2) * 6}deg) scale(1.12)`, opacity: 1 },
      { offset: 0.82, transform: `translate(${off}px, ${up}px) rotate(${(i - (n - 1) / 2) * 6}deg) scale(1.12)`, opacity: 1 },
      { transform: "none", opacity: 0 },
    ], { duration: 1500, delay: delay + i * 70, easing: "cubic-bezier(.3,.6,.3,1)", fill: "both" });
    a.onfinish = () => g.remove();
    setTimeout(() => g.remove(), delay + 2600);
  });
}
