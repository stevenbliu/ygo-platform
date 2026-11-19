// Plays animation intents (intents.ts) on the duel board with the Web Animations API.
//
//   capture(intents)  — call while the DOM still shows the OLD board: records where every card
//                       and zone is on screen.
//   play()            — call right after React committed the NEW board (useLayoutEffect):
//                       FLIPs real card elements from their old spot, flies ghost cards to piles,
//                       rotates, shuffles, lunges.
//
// Nothing here blocks input: animations are transforms on elements that stay clickable, ghosts
// live in a pointer-events:none layer, and every timeline is capped well under a second.
// prefers-reduced-motion: no motion at all (the board just updates); sounds still play.

import type { Position } from "../../../../shared/duel.ts";
import { getCard } from "../useDuel.ts";
import { attackStyle } from "./categories.ts";
import * as fx from "./fx.ts";
import * as sfxv from "./summonFx.ts";
import { cardStars, starLabel } from "./stars.ts";
import { RARITY_LABEL, isPreset } from "../../../../shared/rarity.ts";
import { duelSettings } from "../duelSettings.ts";
import { uiZoom } from "../uiScale.ts";
import type { Intent, Spot } from "./intents.ts";
import { play as sfx, type Sfx } from "./sfx.ts";
import { BEAT_MS } from "../../../../shared/pacing.ts";

export const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const MOVE_MS = 330, ROTATE_MS = 280, SHUFFLE_MS = 420, ATTACK_MS = 440, PULSE_MS = 600;
/** The beat each intent gets before the next one starts (shared/pacing.ts: a summon or an activation holds the
 *  stage for about a second), and the cap on the whole timeline's start offsets (a long combo plays faster). */
const STAGGER: Record<Intent["t"], number> = { effect: 380, banner: 700, beat: 0, move: 90, rotate: 60, shuffle: 80, attack: BEAT_MS.attack, pulse: 40, excavate: 900, summon: BEAT_MS.summon, activate: BEAT_MS.activate };
const beatOf = (it: Intent) => (it.t === "beat" ? it.ms : it.t === "move" && it.style === "draw" ? BEAT_MS.drawEach : it.t === "summon" && it.how === "set" ? BEAT_MS.set : STAGGER[it.t]);
/** Waiting for a timeline to finish never takes longer than this (a stuck animation can't block the duel). */
const SETTLE_CAP = 9000;
const MAX_OFFSET = 6000;

type Rects = Map<string, DOMRect>;

function zoneKeyOf(el: HTMLElement): string {
  const { zone, player, slot } = el.dataset;
  if (zone === "extraMonster") return `extraMonster:${slot ?? 0}`;
  return `${zone}:${player}:${slot ?? ""}`;
}

const posTransform = (p?: Position) => (p === "def" || p === "faceDownDef" ? "rotate(90deg) scale(.7)" : "none");
const center = fx.center;

export class BoardAnimator {
  root: HTMLElement | null = null;
  private pending: { intents: Intent[]; rects: Rects; flipRest: boolean; floor: number } | null = null;
  /** The current timeline holds the stage until then (performance.now()); see settle(). */
  private holdUntil = 0;
  private waiters = new Set<() => void>();
  /** Count of animations started (debug / tests). */
  played = 0;

  /** Record the current layout for `intents`. Merges with a capture that hasn't been played yet. */
  /** `floor`: the least time this update holds the stage (ms), e.g. a phase banner that isn't an intent. */
  capture(intents: Intent[], flipRest = false, floor = 0) {
    if (!this.root) { this.pending = null; return; }
    // nothing to animate: don't measure (it forces a layout of the whole 3D board)
    if (!intents.length && !flipRest && !floor && !this.pending) return;
    if (this.pending) {   // two updates before one render: the DOM still shows the first layout
      this.pending.intents.push(...intents);
      this.pending.flipRest ||= flipRest;
      this.pending.floor += floor;
      return;
    }
    this.pending = { intents: [...intents], rects: reducedMotion() ? new Map() : this.measure(), flipRest, floor };
  }

  /** Resolves once the update just shown has played out: its beats (shared/pacing.ts) have passed and its
   *  animations have finished, or it was skipped. The socket waits for this before it shows the next update or
   *  prompt, so every summon / activation / phase gets its moment before anyone is asked to decide. */
  settle(): Promise<void> {
    return new Promise((resolve) => {
      const start = performance.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => { clearTimeout(timer); this.waiters.delete(done); resolve(); };
      this.waiters.add(done);
      const check = () => {
        // a hidden tab: nothing to watch, don't hold the duel up
        if (!this.root || document.hidden || performance.now() - start > SETTLE_CAP) return done();
        if (this.pending) { timer = setTimeout(check, 30); return; }   // not on screen yet (React is rendering it)
        const left = this.holdUntil - performance.now();
        if (left > 0) { timer = setTimeout(check, Math.min(left, 250)); return; }
        if (this.busy()) { timer = setTimeout(check, 60); return; }
        done();
      };
      // React renders the new board and play() runs in a layout effect first
      timer = setTimeout(check, 30);
    });
  }
  /** One-off animations still running (not endless ambience, not CSS hover transitions). */
  private busy(): boolean {
    return !!this.root?.getAnimations({ subtree: true }).some((a) =>
      !(a instanceof CSSTransition) && !(a instanceof CSSAnimation) && a.playState === "running" && a.effect?.getTiming().iterations !== Infinity);
  }
  /** The stage is held for the update just shown (its beats haven't passed yet). */
  holding(): boolean { return this.holdUntil > performance.now() || this.waiters.size > 0 && this.busy(); }
  /** Stop waiting: whatever waits on settle() goes on now. */
  release() { this.holdUntil = 0; for (const w of [...this.waiters]) w(); }

  private measure(): Rects {
    const rects: Rects = new Map();
    const root = this.root!;
    root.querySelectorAll<HTMLElement>("[data-zone]").forEach((el) => rects.set(`zone:${zoneKeyOf(el)}`, el.getBoundingClientRect()));
    root.querySelectorAll<HTMLElement>(".duel-card[data-uid]").forEach((el) => {
      if (!el.closest(".duel-modal")) rects.set(`uid:${el.dataset.uid}`, el.getBoundingClientRect());
    });
    return rects;
  }

  private el(uid: string): HTMLElement | null {
    return this.root?.querySelector<HTMLElement>(`.duel-board-wrap .duel-card[data-uid="${CSS.escape(uid)}"], .duel-pendulum .duel-card[data-uid="${CSS.escape(uid)}"]`) ?? null;
  }
  private zoneEl(key: string): HTMLElement | null {
    if (!this.root) return null;
    for (const el of this.root.querySelectorAll<HTMLElement>("[data-zone]")) if (zoneKeyOf(el) === key) return el;
    return null;
  }
  private fromRect(rects: Rects, s: Spot): DOMRect | undefined {
    return (s.uid && rects.get(`uid:${s.uid}`)) || rects.get(`zone:${s.zone}`);
  }
  private nowRect(s: Spot): DOMRect | undefined {
    const el = (s.uid && this.el(s.uid)) || this.zoneEl(s.zone);
    return el?.getBoundingClientRect();
  }

  /** Run what `capture` recorded against the freshly rendered board. */
  play() {
    const p = this.pending;
    this.pending = null;
    if (!p || !this.root) return;
    this.speed = duelSettings().animSpeed || 1;
    sfxv.setFxSpeed(this.speed);
    this.sounds(p.intents);
    const speed = this.speed;
    if (reducedMotion()) { this.holdUntil = performance.now() + p.floor / speed; return; }
    const flipped = new Set<string>();
    // several Pendulum monsters arriving at once from the hand / Extra Deck = a Pendulum Summon
    const pendulums = p.intents.filter((it) => it.t === "summon" && it.how === "special" && (it.from === "hand" || it.from === "extra") && /Pendulum/i.test(getCard(it.code)?.type ?? "")).length;
    let offset = 0;
    const total = p.intents.reduce((t, i) => t + beatOf(i), 0);
    const squeeze = total > MAX_OFFSET ? MAX_OFFSET / total : 1;
    for (const it of p.intents) {
      const delay = Math.round(offset);
      offset += beatOf(it) * squeeze;
      try {
        switch (it.t) {
          case "move": this.move(p.rects, it, delay, flipped); break;
          case "rotate": this.rotate(it, delay); break;
          case "shuffle": this.shuffle(it.zone, delay); break;
          case "excavate": this.excavate(it.zone, it.codes, delay); break;
          case "attack": this.attack(it.attacker, it.target, it.side, delay, false, it.code); break;
          case "effect": this.effect(p.rects, it, delay); break;
          case "pulse": this.pulse(it.uid, it.tone, delay); break;
          case "summon": this.summon(it, delay, pendulums >= 2); break;
          case "activate": this.activate(it, delay); break;
          case "banner": this.banner(it.text, delay); break;
          case "beat": break;
        }
      } catch (e) { console.warn("animation", e); }
    }
    if (p.flipRest) this.flipRest(p.rects, flipped);
    this.holdUntil = performance.now() + Math.max(offset, p.floor) / speed;
  }

  /** One sound per kind of thing that happened, in timeline order. */
  private sounds(intents: Intent[]) {
    const seen = new Set<Sfx>();
    // summons / activations with their own effects bring their own sounds (summonFx); the generic ones are for
    // "off" mode and manual rooms
    const own = duelSettings().summonFx !== "off" && intents.some((i) => i.t === "summon" || i.t === "activate");
    let offset = 0;
    for (const it of intents) {
      let s: Sfx | null = null;
      if (it.t === "move") {
        const to = it.to.zone.split(":")[0], from = it.from.zone.split(":")[0];
        s = from === "deck" && to === "hand" ? "draw"
          : to === "monster" || to === "extraMonster" ? (own ? null : it.faceUp ? "summon" : "set")
          : to === "spelltrap" || to === "field" ? (own ? null : it.faceUp ? "chain" : "set")
          : null;
        if (it.style === "shatter") s = "damage";
        if (it.style === "tribute" || it.style === "material") s = "resolve";
        if (it.style === "send" || it.style === "mill") s = "set";
      } else if (it.t === "attack") s = "attack";
      else if (it.t === "effect") s = it.kind === "negate" ? "damage" : it.kind === "burn" ? "damage" : it.kind === "revive" || it.kind === "search" ? "gain" : "chain";
      else if (it.t === "shuffle") s = "shuffle";
      else if (it.t === "excavate") s = "draw";
      // a link resolving sounds like its resolve animation (the duel setting), in the sound theme
      else if (it.t === "pulse") s = it.tone === "activate" ? "chain" : it.tone === "resolve" ? `resolve-${duelSettings().resolveFx}` : null;
      else if (it.t === "rotate" && it.reveal) s = "summon";
      else if (it.t === "summon") s = own ? null : it.how === "set" ? "set" : "summon";
      else if (it.t === "activate") s = own ? null : "chain";
      if (s && !seen.has(s)) {
        seen.add(s);
        const name = s;
        setTimeout(() => sfx(name), Math.min(offset, MAX_OFFSET));
      }
      offset += STAGGER[it.t];
    }
  }

  /** Manual mode: every other card that changed place (hand reflow, ...) slides there. */
  private flipRest(rects: Rects, done: Set<string>) {
    this.root!.querySelectorAll<HTMLElement>(".duel-board-wrap .duel-card[data-uid]").forEach((el) => {
      const uid = el.dataset.uid!;
      if (done.has(uid)) return;
      const was = rects.get(`uid:${uid}`);
      if (!was) return;
      const now = el.getBoundingClientRect();
      const dx = was.left - now.left, dy = was.top - now.top;
      if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
      this.run(el, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 220, easing: "ease-out" });
    });
  }

  private run(el: Element, frames: Keyframe[], opts: KeyframeAnimationOptions) {
    this.played++;
    // the duel's animation speed: everything plays faster (durations and delays)
    const k = this.speed;
    const o = k === 1 ? opts : { ...opts, duration: typeof opts.duration === "number" ? opts.duration / k : opts.duration, delay: (opts.delay ?? 0) / k };
    return el.animate(frames, { fill: "backwards", ...o });
  }
  private speed = 1;

  /** Skip what's playing (Space / a click during a splash): every running one-off animation jumps to its
   *  end, queued splashes and their sounds are dropped. True when there was something to skip. */
  skip(): boolean {
    if (!this.root) return false;
    const anims = this.root.getAnimations({ subtree: true }).filter((a) =>
      !(a instanceof CSSAnimation) && a.effect && a.effect.getTiming().iterations !== Infinity && a.playState === "running");
    if (!anims.length) {
      if (this.holding()) { this.release(); return true; }
      return false;
    }
    for (const a of anims) { try { a.finish(); } catch { /* an endless one: leave it */ } }
    sfxv.resetSplashQueue();
    this.release();
    return true;
  }
  /** A splash shows now: the page lets a click / Space skip it. */
  splashing(): boolean {
    return !!this.root?.querySelector(".duel-anim-layer > .sfx-show, .duel-anim-layer > .sfx-portal, .duel-anim-layer > .sfx-splash, .duel-anim-layer > .sfx-cutin, .duel-anim-layer > .sfx-holo, .duel-anim-layer > .sfx-comic, .duel-anim-layer > .sfx-spot, .duel-anim-layer > .sfx-g");
  }
  /** A new duel in this room (rematch). */
  resetDuel() { /* nothing kept per duel */ }

  private move(rects: Rects, it: Extract<Intent, { t: "move" }>, delay: number, flipped: Set<string>) {
    const from = this.fromRect(rects, it.from);
    if (!from) return;
    const layer = this.layer();
    const run = this.run.bind(this);
    // destroyed cards shatter where they stood, banished ones dissolve: no flight to the pile
    if (layer && (it.style === "shatter" || it.style === "dissolve") && !it.to.zone.startsWith("hand")) {
      (it.style === "shatter" ? fx.shatter : fx.dissolve)(layer, run, from, it.code, it.faceUp || it.code > 0, delay);
      if (it.to.uid) flipped.add(it.to.uid);
      return;
    }
    // tributes rise away where they stood; materials fly into the monster they become
    if (layer && it.style === "tribute") { fx.ascend(layer, run, from, it.code, it.faceUp || it.code > 0, delay); if (it.to.uid) flipped.add(it.to.uid); return; }
    if (layer && it.style === "material" && it.via) {
      const into = this.nowRect(it.via);
      if (into) { fx.converge(layer, run, from, into, it.code, it.faceUp || it.code > 0, delay); if (it.to.uid) flipped.add(it.to.uid); return; }
    }
    if (layer && (it.style === "send" || it.style === "mill")) {
      const to = this.nowRect(it.to);
      if (to) { fx.arcTo(layer, run, from, to, it.code, it.faceUp || it.code > 0, delay, it.style === "mill"); if (it.to.uid) flipped.add(it.to.uid); return; }
    }
    if (layer && it.style === "whoosh") fx.whoosh(layer, run, from, delay);
    if (layer && it.style === "pillar") { const to = this.nowRect(it.to); if (to) fx.pillar(layer, run, to, delay + 120); }
    if (layer && it.style === "sparkle") { const to = this.nowRect(it.to); if (to) fx.sparkle(layer, run, from, to, delay); }
    // drawn: lifts off the Deck and flies to its place in the hand (the hand card shows when it lands)
    if (layer && it.style === "draw") {
      const el = it.to.uid ? this.el(it.to.uid) : null;
      const to = el?.getBoundingClientRect() ?? this.nowRect(it.to);
      if (to?.width) {
        if (it.to.uid) flipped.add(it.to.uid);
        // start from the card on top of the Deck (the pile's box is the whole zone)
        const top = this.zoneEl(it.from.zone)?.querySelector(".duel-card-back");
        const start = top?.getBoundingClientRect();
        fx.draw(layer, run, start?.width ? start : from, to, it.code, it.faceUp && it.code > 0, delay, top);
        if (el) run(el, [{ opacity: 0 }, { offset: 0.9, opacity: 0 }, { opacity: 1 }], { duration: fx.DRAW_MS, delay, fill: "backwards" });
        return;
      }
    }
    const target = it.flip && it.to.uid && !flipped.has(it.to.uid) ? this.el(it.to.uid) : null;
    if (target) {
      flipped.add(it.to.uid!);
      const to = target.getBoundingClientRect();
      if (!to.width) return;
      const a = center(from), b = center(to);
      const dx = a.x - b.x, dy = a.y - b.y, s = Math.max(0.4, Math.min(2.5, from.width / to.width));
      if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
      const start = `translate(${dx}px, ${dy}px) scale(${s})`;
      const frames: Keyframe[] = it.reveal
        ? [{ transform: start, zIndex: 30 }, { offset: 0.6, transform: "translate(0, 0) scale(1.06)", zIndex: 30 }, { offset: 0.8, transform: "scaleX(0.08) scaleY(1.04)", zIndex: 30 }, { transform: "none", zIndex: 30 }]
        : [{ transform: start, zIndex: 30 }, { offset: 0.85, transform: "scale(1.04)", zIndex: 30 }, { transform: "none", zIndex: 30 }];
      this.run(target, frames, { duration: it.reveal ? MOVE_MS + 80 : MOVE_MS, delay, easing: "cubic-bezier(.2,.7,.3,1)" });
      return;
    }
    const to = this.nowRect(it.to);
    if (!to) return;
    this.ghost(from, to, it.code, it.faceUp, delay);
  }

  /** A card-shaped element that flies from -> to above the board, then disappears. */
  private ghost(from: DOMRect, to: DOMRect, code: number, faceUp: boolean, delay: number) {
    const layer = this.layer();
    if (!layer) return;
    const w = from.width || to.width, h = from.height || to.height;
    const g = fx.cardEl(code, faceUp, { left: from.left, top: from.top, width: w, height: h });
    layer.appendChild(g);
    // aim at the target's centre, scaled to its size (piles are card sized; zones a bit bigger)
    const tw = Math.min(to.width, to.height * (59 / 86)) || w;
    const s = tw / w;
    const dx = to.left + to.width / 2 - (from.left + w / 2), dy = to.top + to.height / 2 - (from.top + h / 2);
    const anim = this.run(g, [
      { transform: "none", opacity: 1 },
      { offset: 0.85, transform: `translate(${dx}px, ${dy}px) scale(${s})`, opacity: 1 },
      { transform: `translate(${dx}px, ${dy}px) scale(${s})`, opacity: 0 },
    ], { duration: MOVE_MS + 40, delay, easing: "cubic-bezier(.3,.6,.3,1)", fill: "both" });
    const done = () => g.remove();
    anim.onfinish = done;
    anim.oncancel = done;
    setTimeout(done, MOVE_MS + delay + 600);   // in case the tab was hidden
  }

  private layer(): HTMLElement | null {
    if (!this.root) return null;
    let l = this.root.querySelector<HTMLElement>(":scope > .duel-anim-layer");
    if (!l) {
      l = document.createElement("div");
      l.className = "duel-anim-layer";
      l.setAttribute("aria-hidden", "true");
      this.root.appendChild(l);
    }
    // effects are placed in screen px: undo the duel page's zoom (uiScale.ts) for this layer
    const z = uiZoom();
    l.style.zoom = z === 1 ? "" : String(1 / z);
    return l;
  }

  private rotate(it: Extract<Intent, { t: "rotate" }>, delay: number) {
    const el = this.el(it.uid);
    const inner = el?.querySelector(".duel-card-inner");
    if (!inner) return;
    const a = posTransform(it.from), b = posTransform(it.to);
    if (a === b && !it.reveal) return;
    const mid = b === "none" ? "" : b;
    const frames: Keyframe[] = it.reveal
      ? [{ transform: a }, { offset: 0.5, transform: `${mid} scaleX(0.05)`.trim() }, { transform: b }]
      : [{ transform: a }, { transform: b }];
    this.run(inner, frames, { duration: ROTATE_MS, delay, easing: "ease-in-out" });
  }

  /** Excavated cards lift off the Deck, fan out face-up above it, then settle back. */
  private excavate(zone: string, codes: number[], delay: number) {
    const deck = this.zoneEl(zone)?.getBoundingClientRect();
    const layer = this.layer();
    if (!deck || !layer || !codes.length) return;
    fx.fan(layer, this.run.bind(this), deck, codes, delay);
  }

  /** Shuffle wiggle + sound for one zone, outside a captured board update (e.g. a local hand shuffle). */
  shuffleZone(zone: string) {
    sfx("shuffle");
    if (!reducedMotion()) this.shuffle(zone, 0);
  }

  private shuffle(zone: string, delay: number) {
    const z = this.zoneEl(zone);
    if (!z) return;
    const cards = [...z.querySelectorAll<HTMLElement>(".duel-card")];
    cards.forEach((c, i) => {
      const dir = i % 2 ? -1 : 1;
      this.run(c, [
        { transform: "none" },
        { offset: 0.2, transform: `translateX(${8 * dir}px) rotate(${5 * dir}deg)` },
        { offset: 0.45, transform: `translateX(${-7 * dir}px) rotate(${-4 * dir}deg)` },
        { offset: 0.7, transform: `translateX(${5 * dir}px) rotate(${3 * dir}deg)` },
        { transform: "none" },
      ], { duration: SHUFFLE_MS, delay: delay + Math.min(i, 6) * 25, easing: "ease-in-out" });
    });
  }

  /** The attacker lunges at its target (or at the defending player's side) and back. Usable without a capture. */
  attack(attackerUid: string, targetUid: string | null, side: 0 | 1, delay = 0, sound = false, code?: number) {
    if (sound) sfx("attack");
    if (!this.root || reducedMotion()) return;
    const a = this.el(attackerUid);
    if (!a) return;
    const t = targetUid ? this.el(targetUid) : (this.plate(side) ?? this.zoneEl(`hand:${side}:`));
    const ar = a.getBoundingClientRect();
    const tr = t?.getBoundingClientRect();
    if (!tr) return;
    // a legendary monster's attack is a moment: the card first, then the strike
    const data = code ? getCard(code) : null;
    if (data && cardStars(data) === 3) {
      const layer0 = this.layer();
      const sp = layer0 ? this.wantSplash() : null;
      if (layer0 && sp) delay = sfxv.splash(layer0, this.run.bind(this), { code: code!, name: data.name, kicker: this.kicker(data, targetUid ? "Attacks" : "Direct attack", a.dataset.foil), rarity: a.dataset.foil, tone: "#ff6a3c", at: ar, ...this.splashAt(ar, "summon"), short: true, skipHint: true }, delay);
    }
    const p = center(ar), q = center(tr);
    const dx = (q.x - p.x) * 0.72, dy = (q.y - p.y) * (targetUid ? 0.72 : 0.5);
    this.arrow(p, q, delay);
    const layer = this.layer();
    if (layer) {
      const { element, shape } = attackStyle(code ? getCard(code) : null);
      const hitIn = fx.strike(layer, this.run.bind(this), ar, tr, element, shape, delay + 120);
      fx.impact(layer, this.run.bind(this), tr, element, delay + 120 + hitIn);
    }
    this.run(a, [
      { transform: "none", zIndex: 30 },
      { offset: 0.25, transform: `translate(${-dx * 0.08}px, ${-dy * 0.08}px) scale(1.06)`, zIndex: 30 },
      { offset: 0.5, transform: `translate(${dx}px, ${dy}px) scale(1.12)`, zIndex: 30 },
      { transform: "none", zIndex: 30 },
    ], { duration: ATTACK_MS, delay, easing: "ease-in-out" });
    if (t && targetUid) {
      this.run(t, [
        { transform: "none" }, { offset: 0.3, transform: "translateX(-5px) rotate(-2deg)" },
        { offset: 0.6, transform: "translateX(5px) rotate(2deg)" }, { transform: "none" },
      ], { duration: 220, delay: delay + ATTACK_MS * 0.45, easing: "ease-in-out" });
    }
  }

  /** The Life Points plate of a seat (burn / direct attack target). */
  private plate(seat: number): HTMLElement | null {
    return this.root?.querySelector<HTMLElement>(`.duel-playerbar[data-seat="${seat}"] .duel-lp`) ?? null;
  }

  /** A card effect's category visual. */
  private effect(rects: Rects, it: Extract<Intent, { t: "effect" }>, delay: number) {
    const layer = this.layer();
    if (!layer) return;
    const run = this.run.bind(this);
    const rectOf = (s: Spot) => this.fromRect(rects, s) ?? this.nowRect(s);
    const src = it.source ? (rects.get(`uid:${it.source}`) ?? this.el(it.source)?.getBoundingClientRect()) : undefined;
    const targets = it.targets.map(rectOf).filter((r): r is DOMRect => !!r && r.width > 0);
    switch (it.kind) {
      case "wipe": {
        const field = this.root!.querySelector(".duel-field")?.getBoundingClientRect();
        if (!field) return;
        const half = it.side === undefined ? field : this.sideRect(field, it.side);
        fx.vortex(layer, run, half, delay);
        return;
      }
      case "trapHole": targets.forEach((r) => fx.pit(layer, run, r, delay)); return;
      case "negate": targets.forEach((r) => fx.stamp(layer, run, r, delay)); return;
      case "destroy": targets.forEach((r) => fx.ring(layer, run, r, delay, "tone-danger")); return;
      case "banish": targets.forEach((r) => fx.ring(layer, run, r, delay, "tone-void")); return;
      case "bounce": targets.forEach((r) => fx.whoosh(layer, run, r, delay)); return;
      case "burn": {
        const to = it.to !== undefined ? this.plate(it.to)?.getBoundingClientRect() : undefined;
        if (src && to) fx.fireball(layer, run, src, to, delay);
        else if (src) fx.ring(layer, run, src, delay, "tone-fire");
        return;
      }
      case "handtrap": {
        const el = it.source ? this.el(it.source) : null;
        if (el) run(el, [{ transform: "none", zIndex: 30 }, { offset: 0.4, transform: "translateY(-28px) scale(1.35)", zIndex: 30 }, { offset: 0.7, transform: "translateY(-18px) scale(1.25)", zIndex: 30 }, { transform: "none", zIndex: 30 }], { duration: 520, delay, easing: "cubic-bezier(.3,1.4,.5,1)" });
        if (src) fx.ring(layer, run, src, delay + 200, "tone-accent");
        return;
      }
      case "revive": case "search": if (src) fx.ring(layer, run, src, delay, "tone-light"); return;
      default: if (src) fx.ring(layer, run, src, delay, "tone-accent");
    }
  }

  /** The half of the field that belongs to `seat` (top half = the opponent of the viewer). */
  private sideRect(field: DOMRect, seat: number): DOMRect {
    const mine = this.root?.querySelector<HTMLElement>(`.duel-field [data-zone="monster"][data-player="${seat}"]`);
    const z = mine?.getBoundingClientRect();
    const top = z ? z.top < field.top + field.height / 2 : false;
    return new DOMRect(field.left, top ? field.top : field.top + field.height / 2, field.width, field.height / 2);
  }

  /** A line from the attacker to its target that draws itself, then fades. */
  private arrow(p: { x: number; y: number }, q: { x: number; y: number }, delay: number) {
    const layer = this.layer();
    if (!layer) return;
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "duel-attack-arrow");
    svg.setAttribute("width", String(innerWidth));
    svg.setAttribute("height", String(innerHeight));
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    const line = document.createElementNS(NS, "line");
    line.setAttribute("x1", String(p.x)); line.setAttribute("y1", String(p.y));
    line.setAttribute("x2", String(q.x)); line.setAttribute("y2", String(q.y));
    line.setAttribute("stroke-dasharray", String(len));
    line.setAttribute("marker-end", "url(#duel-arrowhead)");
    const defs = document.createElementNS(NS, "defs");
    const marker = document.createElementNS(NS, "marker");
    marker.setAttribute("id", "duel-arrowhead"); marker.setAttribute("viewBox", "0 0 10 10");
    marker.setAttribute("refX", "6"); marker.setAttribute("refY", "5");
    marker.setAttribute("markerWidth", "5"); marker.setAttribute("markerHeight", "5"); marker.setAttribute("orient", "auto-start-reverse");
    const head = document.createElementNS(NS, "path");
    head.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
    marker.appendChild(head); defs.appendChild(marker); svg.appendChild(defs); svg.appendChild(line);
    layer.appendChild(svg);
    this.run(line, [{ strokeDashoffset: len }, { offset: 0.4, strokeDashoffset: 0 }, { strokeDashoffset: 0 }], { duration: ATTACK_MS + 200, delay, easing: "ease-out", fill: "both" });
    const fade = this.run(svg, [{ opacity: 1 }, { offset: 0.7, opacity: 1 }, { opacity: 0 }], { duration: ATTACK_MS + 260, delay, fill: "both" });
    const done = () => svg.remove();
    fade.onfinish = done; fade.oncancel = done;
    setTimeout(done, ATTACK_MS + delay + 900);
  }

  /** A short centred text ribbon over the board (chain resolving, ...). */
  private banner(text: string, delay: number) {
    const layer = this.layer();
    if (!layer) return;
    const el = document.createElement("div");
    el.className = "duel-ribbon";
    el.textContent = text;
    layer.appendChild(el);
    const a = this.run(el, [
      { opacity: 0, transform: "translate(-50%, -50%) scaleX(.6)" },
      { offset: 0.2, opacity: 1, transform: "translate(-50%, -50%) scaleX(1)" },
      { offset: 0.8, opacity: 1, transform: "translate(-50%, -50%) scaleX(1)" },
      { opacity: 0, transform: "translate(-50%, -50%) scaleX(1.05)" },
    ], { duration: 900, delay, fill: "both" });
    const done = () => el.remove();
    a.onfinish = done; a.oncancel = done;
    setTimeout(done, delay + 1500);
  }

  /** Brief shake of the whole board (damage). */
  shake() {
    const b = this.root?.querySelector(".duel-board-wrap");
    if (!b || reducedMotion()) return;
    this.run(b, [
      { transform: "none" }, { offset: 0.2, transform: "translate(-4px, 1px)" }, { offset: 0.4, transform: "translate(4px, -1px)" },
      { offset: 0.6, transform: "translate(-3px, 0)" }, { offset: 0.8, transform: "translate(2px, 1px)" }, { transform: "none" },
    ], { duration: 320, easing: "ease-in-out" });
  }

  /** Whether this moment gets the card-art splash: every summon (but a Set) and every activation does, the
   *  same way every time ("short" setting: the shorter splash; "off": none). How famous the card is only
   *  changes its label and size, never whether it plays. */
  private wantSplash(): "full" | "short" | null {
    const mode = duelSettings().summonFx;
    return mode === "off" ? null : mode;
  }
  /** "Ultra Rare · Synchro Summon", or "Staple · Synchro Summon" for a common copy. */
  private kicker(card: ReturnType<typeof getCard>, what: string, foil?: string) {
    const rarity = foil && foil !== "common" ? (isPreset(foil) ? RARITY_LABEL[foil] : "Custom foil") : null;
    const why = rarity ?? starLabel(card);
    return why ? `${why} · ${what}` : what;
  }
  /** The middle of the field, and whether a card at `r` is on the viewer's (lower) half. */
  private splashAt(r: DOMRect, what: "summon" | "activate"): { center: { x: number; y: number }; mine: boolean; style: sfxv.SplashStyle } {
    const f = this.root?.querySelector(".duel-field")?.getBoundingClientRect();
    const center = f ? { x: f.left + f.width / 2, y: f.top + f.height / 2 } : { x: innerWidth / 2, y: innerHeight / 2 };
    const s = duelSettings();
    return { center, mine: r.top + r.height / 2 >= center.y, style: what === "summon" ? s.summonSplash : s.activateSplash };
  }

  private summon(it: Extract<Intent, { t: "summon" }>, delay: number, pendulumBatch: boolean) {
    const layer = this.layer();
    const card = this.el(it.uid);
    const r = (card ?? this.zoneEl(it.zone))?.getBoundingClientRect();
    if (!layer || !r?.width) return;
    if (duelSettings().summonFx === "off") { this.pulse(it.uid, "summon", delay); return; }
    const data = it.code ? getCard(it.code) : null;
    const kind = sfxv.summonKindOf(data, it.how, it.from, pendulumBatch);
    const big = sfxv.isBig(data);
    const extra = kind === "fusion" || kind === "synchro" || kind === "xyz" || kind === "link" || kind === "ritual" || kind === "pendulum";
    // the card has just landed (it flew in from the hand / Extra Deck): start once it's there
    let at = delay + MOVE_MS - 40;
    const run = this.run.bind(this);
    // every summon gets its splash (a Set card stays hidden); famous cards and bosses get the bigger one
    const stars = cardStars(data);
    const sp = it.code > 0 && kind !== "set" ? this.wantSplash() : null;
    if (sp && data) {
      at = sfxv.splash(layer, run, { code: it.code, name: data.name, kicker: this.kicker(data, sfxv.SUMMON_LABEL[kind], card?.dataset.foil), rarity: card?.dataset.foil, tone: sfxv.toneOf(kind), at: r, ...this.splashAt(r, "summon"), big: big || extra || stars === 3, short: sp === "short", skipHint: true }, at);
    }
    sfxv.summon(layer, run, r, kind, at, { card, stage: this.root?.querySelector(".duel-board-wrap"), big, markers: data?.linkmarkers });
  }

  private activate(it: Extract<Intent, { t: "activate" }>, delay: number) {
    const layer = this.layer();
    const card = this.el(it.uid);
    const r = (card ?? this.zoneEl(it.zone))?.getBoundingClientRect();
    if (!layer || !r?.width) return;
    if (duelSettings().summonFx === "off") { this.pulse(it.uid, "activate", delay); return; }
    const data = it.code ? getCard(it.code) : null;
    const kind = sfxv.activateKindOf(data);
    const tone = sfxv.toneOf(kind, data);
    const run = this.run.bind(this);
    let at = delay;
    // every activation gets its splash (chain link 2 and up the shorter one)
    const stars = cardStars(data);
    const sp = data ? this.wantSplash() : null;
    if (sp && data) {
      const what = it.link > 1 ? `Chain ${it.link} · ${sfxv.ACTIVATE_LABEL[kind]}` : sfxv.ACTIVATE_LABEL[kind];
      at = sfxv.splash(layer, run, { code: it.code, name: data.name, kicker: this.kicker(data, what, card?.dataset.foil), rarity: card?.dataset.foil, tone, at: r, ...this.splashAt(r, "activate"), big: stars === 3 && it.link === 1, short: sp === "short" || it.link > 1, skipHint: true }, at);
    }
    sfxv.activate(layer, run, r, kind, at, { card, tone });
    const prev = it.prev ? this.el(it.prev)?.getBoundingClientRect() ?? null : null;
    sfxv.chainLine(layer, run, prev?.width ? prev : null, r, it.link, at);
  }

  private pulse(uid: string, tone: "activate" | "summon" | "target" | "resolve", delay: number) {
    const el = this.el(uid);
    if (!el) return;
    const color = tone === "target" ? "var(--danger)" : tone === "summon" ? "var(--ok)" : tone === "resolve" ? "var(--warn)" : "var(--accent)";
    this.run(el, [
      { boxShadow: `0 0 0 0 ${color}` },
      { offset: 0.4, boxShadow: `0 0 0 5px ${color}` },
      { boxShadow: "0 0 0 10px transparent" },
    ], { duration: PULSE_MS, delay: delay + (tone === "summon" ? MOVE_MS - 60 : 0), easing: "ease-out" });
  }
}
