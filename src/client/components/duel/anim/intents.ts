// What to animate after a board update, as plain data (no DOM): one list of intents for both
// modes. Engine mode derives them from the engine's events (its board uids are positions, so
// cards can't be followed by uid); manual mode diffs the two boards by uid (stable per copy).
// The animator (animator.ts) resolves each Spot to a screen rectangle and plays them in order.
//
// Only codes the viewer can already see are used (events and boards arrive masked), so no
// effect ever hints at a hidden card.

import type { BoardState, CardInstance, Position } from "../../../../shared/duel.ts";
import { BEAT_MS } from "../../../../shared/pacing.ts";
import type { EngineCardRef, EngineEvent, Seat } from "../../../../shared/enginePrompts.ts";
import { engineFirst, indexBoard, overlayHostUid, refUid, refZone, zoneKey, type Located } from "../../engine/boardRefs.ts";
import type { ZoneRef } from "../Board.tsx";
import type { EffectKind } from "./categories.ts";

/** A place on screen: a card element by uid when there is one, else the zone / pile element. */
export interface Spot { uid?: string; zone: string }

/** How a moving card leaves / arrives: destroyed cards shatter, banished ones dissolve, revived ones rise in light… */
export type MoveStyle = "shatter" | "dissolve" | "pillar" | "sparkle" | "whoosh"
  /** drawn: lifts off the Deck, flips face-up (your own draws) on its way and lands in the hand */
  | "draw"
  /** released as a Tribute: rises away in a golden glow */
  | "tribute"
  /** used as Synchro / Xyz / Fusion / Link material: flies into the new monster (`via`) */
  | "material"
  /** sent to the GY by an effect or cost: visibly flies to the GY */
  | "send"
  /** milled: flips off the top of the Deck and arcs into the GY */
  | "mill";

export type Intent =
  /** A card travels from -> to. `flip`: animate the real element at `to.uid` (FLIP); otherwise a ghost card flies. */
  | { t: "move"; from: Spot; to: Spot; code: number; faceUp: boolean; flip: boolean; reveal?: boolean; style?: MoveStyle; via?: Spot }
  /** Excavated / revealed from the top of the Deck: the cards lift and fan out above it, then settle. */
  | { t: "excavate"; zone: string; codes: number[] }
  /** Battle position / face-up change in place. */
  | { t: "rotate"; uid: string; from?: Position; to?: Position; reveal?: boolean }
  | { t: "shuffle"; zone: string }
  /** `code`: the attacker's (visible) code, for its attribute / type themed strike. */
  | { t: "attack"; attacker: string; target: string | null; side: Seat; code?: number }
  /** A monster arrives: its summon signature (the animator picks Fusion / Synchro / ... from the card).
   *  `from`: where it came from (hand, extra, gy...). */
  | { t: "summon"; uid: string; zone: string; code: number; how: "normal" | "tribute" | "set" | "flip" | "special"; from?: string; side: Seat }
  /** A card or effect is activated (chain link `link`; `prev` = the previous link's card). */
  | { t: "activate"; uid: string; zone: string; code: number; side: Seat; link: number; prev?: string }
  /** A short glow: activation, summon landing, targeting, a chain link resolving. */
  | { t: "pulse"; uid: string; tone: "activate" | "summon" | "target" | "resolve" }
  /** A short text ribbon over the board ("Chain Link 2 resolves"). */
  | { t: "banner"; text: string }
  /** Nothing moves: what comes next waits `ms` (a new turn / phase: its banner gets the stage first). */
  | { t: "beat"; ms: number }
  /** A card effect's visual: `source` = the card, `targets` = cards it hit, `side` = whose field (wipes), `to` = burn victim. */
  | { t: "effect"; kind: EffectKind; source?: string; targets: Spot[]; side?: Seat; to?: Seat };

const pileKey = (zone: ZoneRef["zone"], player: Seat) => zoneKey({ zone, player });
const PILES = new Set(["deck", "extra", "gy", "banished"]);
const FIELD = new Set(["monster", "spelltrap", "field", "pendulum", "extraMonster", "overlay"]);

function refSpot(r: EngineCardRef, first: Seat): Spot {
  if (r.location === "overlay") return { uid: overlayHostUid(r), zone: zoneKey(refZone(r, first)) };
  if (PILES.has(r.location)) return { zone: pileKey(r.location as ZoneRef["zone"], r.controller) };
  return { uid: refUid(r), zone: zoneKey(refZone(r, first)) };
}

const faceDown = (p?: Position) => p === "faceDown" || p === "faceDownDef";
const hiddenLoc = (r: EngineCardRef) => r.location === "deck" || r.location === "hand" || faceDown(r.position);

/** Effect kinds that destroy (their field -> GY moves shatter; other effects "send"). */
const DESTROYING = new Set<EffectKind>(["destroy", "wipe", "trapHole"]);

function moveStyle(from: string, to: string, engineSearch: boolean): MoveStyle | undefined {
  if (FIELD.has(from) && to === "gy") return "shatter";
  if (to === "banished") return "dissolve";
  if ((from === "gy" || from === "banished") && (to === "monster" || to === "extraMonster")) return "pillar";
  if (from === "deck" && to === "hand") return engineSearch ? "sparkle" : "draw";
  if (FIELD.has(from) && (to === "hand" || to === "deck" || to === "extra")) return "whoosh";
  return undefined;
}

export interface EngineChain { uid: Map<number, string>; code: Map<number, number> }

/**
 * Engine mode: intents from one step's (already masked) events. `prev` / `next` = boards before
 * / after; `chain` (kept by the caller across steps) remembers each open chain link's card;
 * `kindOf` classifies a visible card code.
 */
export function engineIntents(events: EngineEvent[], prev: BoardState, next: BoardState,
  chain: EngineChain = { uid: new Map(), code: new Map() }, kindOf: (code: number) => EffectKind = () => "generic"): Intent[] {
  const first = engineFirst(next);
  const before = indexBoard(prev), after = indexBoard(next);
  const out: Intent[] = [];
  const handLen: [number, number] = [prev.players[0].hand.length, prev.players[1].hand.length];
  // a move's destination is "final" when nothing later in this batch touches that slot again
  const touches: string[][] = events.map((ev) => {
    if (ev.e === "move") return [ev.from, ev.to].filter((r): r is EngineCardRef => !!r && !PILES.has(r.location)).map(refUid);
    return [];
  });
  const finalAt = (i: number, uid: string) => !touches.slice(i + 1).some((t) => t.includes(uid));
  let resolving: number | null = null;
  let battled = false;
  let tributes = 0;   // monsters released since the last summon (Tribute Summon)
  // where the card now at `uid` came from in this batch
  const cameFrom = (i: number, uid: string) => {
    for (let j = i - 1; j >= 0; j--) { const x = events[j]; if (x.e === "move" && x.to && refUid(x.to) === uid) return x.from?.location; }
    return undefined;
  };
  // the next summon after event i (within a few events), for tributes and Extra Deck materials
  const nextSummon = (i: number) => {
    for (let j = i + 1; j < Math.min(events.length, i + 10); j++) {
      const x = events[j];
      if (x.e === "summon") return { ev: x, j };
      if (x.e === "chain" || x.e === "chainSolving" || x.e === "attack") return null;
    }
    return null;
  };
  const fromExtra = (j: number) => events.slice(Math.max(0, j - 4), j).some((x) => x.e === "move" && x.from?.location === "extra");

  events.forEach((ev, i) => {
    switch (ev.e) {
      // a new turn / phase: the banner (TurnBanner) has the stage before the draw / summon after it
      case "turn": out.push({ t: "beat", ms: BEAT_MS.turn }); return;
      case "phase": if ((!ev.step || ev.step === "start") && ev.phase !== "draw" && ev.phase !== "standby") out.push({ t: "beat", ms: BEAT_MS.phase }); return;
      case "draw": {
        ev.codes.forEach((code, k) => {
          const uid = `e${ev.player}-2-${handLen[ev.player] + k}`;
          out.push({ t: "move", from: { zone: pileKey("deck", ev.player) }, to: { uid, zone: pileKey("hand", ev.player) }, code, faceUp: code > 0, flip: finalAt(i, uid), style: resolving !== null ? "sparkle" : "draw" });
        });
        handLen[ev.player] += ev.codes.length;
        return;
      }
      case "move": {
        const { from, to } = ev;
        if (!from || !to) return;   // tokens appearing / vanishing
        if (from.location === "hand") handLen[from.controller] = Math.max(0, handLen[from.controller] - 1);
        if (to.location === "hand") handLen[to.controller]++;
        const a = refSpot(from, first), b = refSpot(to, first);
        if (a.zone === b.zone && a.uid === b.uid) return;
        const up = !hiddenLoc(to) && to.location !== "extra" && ev.code > 0 || (to.location === "hand" && ev.code > 0);
        const flip = !!b.uid && to.location !== "overlay" && finalAt(i, b.uid);
        // a resolved Spell / Trap going to the GY isn't "destroyed": no shatter for chain cards leaving their zone
        const chainCard = [...chain.uid.values()].includes(refUid(from)) && (from.location === "spelltrap" || from.location === "field");
        let style = chainCard ? undefined : moveStyle(from.location, to.location, resolving !== null);
        let via: Spot | undefined;
        if (FIELD.has(from.location) && (to.location === "gy" || to.location === "overlay" || to.location === "banished") && !chainCard) {
          const sum = nextSummon(i);
          if (sum && sum.ev.how === "normal" && resolving === null) { style = "tribute"; tributes++; }        // Tribute Summon
          else if (sum && sum.ev.how === "special" && fromExtra(sum.j)) { style = "material"; via = refSpot(sum.ev.card, first); }   // Synchro / Xyz / Fusion / Link
          else if (to.location === "gy" && !battled && resolving !== null && !DESTROYING.has(kindOf(chain.code.get(resolving) ?? 0))) style = "send";
          else if (to.location === "gy" && !battled && resolving === null) style = "send";                // costs, rules
        }
        if (from.location === "deck" && to.location === "gy") style = "mill";
        out.push({ t: "move", from: a, to: b, code: ev.code, faceUp: up || style === "mill", flip, reveal: up && hiddenLoc(from) && to.location !== "hand", style, ...(via ? { via } : {}) });
        return;
      }
      case "summon": {
        const uid = refUid(ev.card);
        const zone = zoneKey(refZone(ev.card, first));
        if (ev.how === "flip") {
          const was = before.get(uid)?.card, now = after.get(uid)?.card;
          out.push({ t: "rotate", uid, from: was?.position ?? "faceDownDef", to: now?.position ?? ev.card.position, reveal: true });
        }
        const how = ev.how === "flip" ? "flip" : ev.how === "normal" ? (tributes ? "tribute" : "normal") : "special";
        out.push({ t: "summon", uid, zone, code: ev.card.code, how, from: cameFrom(i, uid), side: ev.card.controller });
        tributes = 0;
        return;
      }
      case "set": {
        if (ev.card.location !== "monster") return;
        const uid = refUid(ev.card);
        out.push({ t: "summon", uid, zone: zoneKey(refZone(ev.card, first)), code: 0, how: "set", side: ev.card.controller });
        return;
      }
      case "reposition": {
        const uid = refUid(ev.card);
        const was = before.get(uid)?.card, now = after.get(uid)?.card;
        if (!was || !now || (was.position === now.position && was.faceUp === now.faceUp)) return;
        out.push({ t: "rotate", uid, from: was.position, to: now.position, reveal: !was.faceUp && now.faceUp });
        return;
      }
      case "chain": {
        const uid = refUid(ev.card);
        chain.uid.set(ev.link, uid);
        if (ev.card.code) chain.code.set(ev.link, ev.card.code);
        out.push({ t: "activate", uid, zone: zoneKey(refZone(ev.card, first)), code: ev.card.code, side: ev.card.controller, link: ev.link, prev: chain.uid.get(ev.link - 1) });
        // hand traps flash and slam forward as they are activated
        if (ev.card.location === "hand" && ev.card.code && kindOf(ev.card.code) === "handtrap") out.push({ t: "effect", kind: "handtrap", source: uid, targets: [] });
        return;
      }
      case "chainSolving": {
        resolving = ev.link;
        const uid = chain.uid.get(ev.link), code = chain.code.get(ev.link);
        if (chain.uid.size > 1) out.push({ t: "banner", text: `Chain Link ${ev.link} resolves` });
        if (uid) out.push({ t: "pulse", uid, tone: "resolve" });
        if (!code) return;
        // what this link does: look ahead to its chainSolved for the cards it moved / the LP it burned
        const end = events.findIndex((x, j) => j > i && (x.e === "chainSolved" || x.e === "chainSolving") && x.link !== undefined);
        const window = events.slice(i + 1, end < 0 ? undefined : end);
        const hit = window.filter((x): x is Extract<EngineEvent, { e: "move" }> => x.e === "move" && !!x.from && FIELD.has(x.from.location));
        const kind = kindOf(code);
        const targets = hit.map((x) => refSpot(x.from!, first));
        const sides = new Set(hit.map((x) => x.from!.controller));
        const burn = window.find((x) => x.e === "lp" && x.delta < 0 && x.cause === "damage");
        if (kind === "burn" || burn) out.push({ t: "effect", kind: "burn", source: uid, targets: [], to: burn && burn.e === "lp" ? burn.player : undefined });
        else if (kind === "wipe" || kind === "trapHole" || kind === "destroy" || kind === "banish" || kind === "bounce") {
          if (targets.length || kind === "wipe") out.push({ t: "effect", kind, source: uid, targets, side: sides.size === 1 ? [...sides][0] : undefined });
        } else if (kind === "revive" || kind === "search" || kind === "negate") out.push({ t: "effect", kind: kind === "negate" ? "generic" : kind, source: uid, targets });
        else out.push({ t: "effect", kind: "generic", source: uid, targets: [] });
        return;
      }
      case "chainSolved": resolving = null; return;
      case "chainNegated": case "chainDisabled": {
        const uid = chain.uid.get(ev.link);
        if (uid) out.push({ t: "effect", kind: "negate", targets: [{ uid, zone: "" }] });
        return;
      }
      case "chainEnd": chain.uid.clear(); chain.code.clear(); resolving = null; return;
      case "target": ev.cards.forEach((c) => out.push({ t: "pulse", uid: refUid(c), tone: "target" })); return;
      case "confirm": {
        // excavating / revealing from the top of the Deck
        const fromDeck = ev.cards.filter((c) => c.location === "deck" && c.code > 0);
        if (fromDeck.length) out.push({ t: "excavate", zone: pileKey("deck", fromDeck[0].controller), codes: fromDeck.map((c) => c.code) });
        return;
      }
      case "battle": battled = true; return;
      case "attack": {
        const attacker = refUid(ev.attacker);
        out.push({ t: "attack", attacker, target: ev.target ? refUid(ev.target) : null, side: (1 - ev.attacker.controller) as Seat, code: after.get(attacker)?.card.code || before.get(attacker)?.card.code || ev.attacker.code || undefined });
        return;
      }
      case "shuffle": out.push({ t: "shuffle", zone: pileKey(ev.where, ev.player) }); return;
      default: return;
    }
  });
  return out;
}

// ---------------------------------------------------------------------------------------
// manual mode: diff by uid

function spotOf(l: Located): Spot {
  if (l.host) return { uid: l.host.uid, zone: zoneKey(l.at) };
  if (PILES.has(l.at.zone) || l.at.zone === "hand") return { uid: l.card.uid, zone: pileKey(l.at.zone, l.at.player) };
  return { uid: l.card.uid, zone: zoneKey(l.at) };
}
const placeOf = (l: Located) => (l.host ? `mat:${l.host.uid}` : PILES.has(l.at.zone) || l.at.zone === "hand" ? pileKey(l.at.zone, l.at.player) : zoneKey(l.at));
const shown = (c: CardInstance) => c.faceUp && c.code !== 0;
const ST = new Set(["spelltrap", "field", "pendulum"]);

/** Manual mode: intents from the difference between two boards. `kindOf` classifies visible spells / traps. */
export function manualIntents(prev: BoardState, next: BoardState, kindOf: (code: number) => EffectKind | null = () => null): Intent[] {
  const before = indexBoard(prev), after = indexBoard(next);
  const out: Intent[] = [];
  const activated: { uid: string; code: number; controller: Seat }[] = [];
  for (const [uid, now] of after) {
    const was = before.get(uid);
    if (!was) continue;   // a new token
    if (placeOf(was) !== placeOf(now)) {
      const handUp = now.at.zone === "hand" && now.card.code !== 0;
      const up = shown(now.card) || handUp;
      const fromZone = was.host ? "overlay" : was.at.zone, toZone = now.host ? "overlay" : now.at.zone;
      out.push({ t: "move", from: spotOf(was), to: spotOf(now), code: now.card.code, faceUp: up, flip: !now.host, reveal: up && !shown(was.card) && was.at.zone !== "hand" && now.at.zone !== "hand", style: moveStyle(fromZone, toZone, false) });
      if (ST.has(now.at.zone) && shown(now.card)) activated.push({ uid, code: now.card.code, controller: now.at.player });
    } else if (!now.host && (was.card.position !== now.card.position || (was.card.faceUp !== now.card.faceUp && !PILES.has(now.at.zone) && now.at.zone !== "hand"))) {
      out.push({ t: "rotate", uid, from: was.card.position, to: now.card.position, reveal: !was.card.faceUp && now.card.faceUp });
      if (ST.has(now.at.zone) && !shown(was.card) && shown(now.card)) activated.push({ uid, code: now.card.code, controller: now.at.player });
    }
  }
  // a Spell / Trap turned face-up = activated: play its category's flourish
  for (const a of activated) {
    const kind = kindOf(a.code);
    if (!kind) continue;
    out.push({ t: "effect", kind: kind === "trapHole" || kind === "destroy" || kind === "banish" || kind === "bounce" || kind === "handtrap" ? "generic" : kind, source: a.uid, targets: [], side: kind === "wipe" ? undefined : a.controller, to: kind === "burn" ? (1 - a.controller) as Seat : undefined });
  }
  for (const p of [0, 1] as Seat[]) {
    const a = prev.players[p].deck.map((c) => c.uid), b = next.players[p].deck.map((c) => c.uid);
    // the manual reducer re-issues every deck uid on a shuffle (so cards can't be tracked through it)
    const same = new Set([...a, ...b]).size === a.length, fresh = !b.some((u) => a.includes(u));
    if (a.length > 1 && a.length === b.length && a.join() !== b.join() && (same || fresh)) {
      out.push({ t: "shuffle", zone: pileKey("deck", p) });
    }
  }
  return out;
}
