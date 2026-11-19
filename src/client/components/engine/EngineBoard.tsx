// Rules-enforced duels played on the board: every engine prompt becomes card highlights,
// context menus, zone picks, a compact floating bar or (for prompts that aren't about cards)
// a small dialog. The list panel (EnginePromptPanel) stays as the fallback for anything that
// can't be shown on the board, and behind the bar's "List" button.

import { usePageFlag } from "../duel/pageFlag.ts";
import { toCss } from "../duel/uiScale.ts";
import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent, type ReactNode } from "react";
import type { BoardState, CardInstance, Position } from "../../../shared/duel.ts";
import type { EngineCardRef, EnginePlace, EnginePrompt, EngineResponse, EngineResponseBody, Seat } from "../../../shared/enginePrompts.ts";
import type { BoardMarks, ZoneRef } from "../duel/Board.tsx";
import { CardBack, CardCaption, CardFace, CardView, type CanKind } from "../duel/CardView.tsx";
import type { MenuItem } from "../duel/menus.ts";
import { Modal } from "../duel/Overlays.tsx";
import { engineFirst, indexBoard, placeZone, refUid, visibleCode, zoneKey } from "./boardRefs.ts";
import { useDuelSettings } from "../duel/duelSettings.ts";
import {
  actionsByUid, answersOnClick, dropChoices, isSelectPrompt, layoutRefs, pileKeyOf, placeKeys,
  selectItems, selectResponse, selectStatus, setGrantNamer, type CardAction, type SelectItem,
} from "./boardPrompt.ts";
import { getCard } from "../duel/useDuel.ts";

// "Activate: ... (from JJ "Kewl Tune")": effects granted by another card name that card
setGrantNamer((code) => getCard(code)?.name ?? "another card");
import { EnginePromptPanel, title } from "./EnginePrompt.tsx";
import { play as sfx } from "../duel/anim/sfx.ts";

export interface EngineBoardOpts {
  prompt: EnginePrompt | null;
  board: BoardState;
  you: Seat;
  respond(r: EngineResponse): void;
  openMenu(m: { x: number; y: number; title?: string; items: MenuItem[] }): void;
  cardName(code: number): string | undefined;
  preview(code: number): void;
  onHover(code: number | null): void;
  showMaterials(uid: string): void;
  toast(text: string): void;
  /** Chain Link badges from the animation layer (uid -> "1" or "1·3"). */
  chainBadges?: Map<string, string>;
  /** The card whose effect the current decision belongs to (resolving / newest chain link). */
  source?: { uid: string; code: number } | null;
}

/** A decision in progress, with a way to step back and look at the board and a way back to it. */
export interface Decision {
  /** Looking at the board: the dock is minimized or the card picker was closed. */
  peeking: boolean;
  peek(): void;
  restore(): void;
}

export interface PhaseActions { battle?: () => void; main2?: () => void; end?: () => void; shuffle?: () => void }

export interface EngineBoard {
  /** Hover action buttons for a card (Main / Battle Phase). */
  quick(uid: string): { label: string; run(): void }[];
  marks: BoardMarks;
  /** Handle a click on a board card (always handled in engine mode). */
  onCard(card: CardInstance, at: ZoneRef, e: MouseEvent): void;
  /** Handle a zone / pile click; false = let the page do its default (open a pile viewer). */
  onZone(at: ZoneRef, e: MouseEvent): boolean;
  onDrop(at: ZoneRef, uid: string, e: DragEvent): void;
  phase: PhaseActions;
  /** One line for the panel under the board ("Your Main Phase: …"). */
  status: string | null;
  /** The engine is waiting for you. */
  yourMove: boolean;
  /** The current decision (not Main / Battle Phase actions), if any. */
  decision: Decision | null;
  /** Floating bar / dialogs / pile picker, rendered by the page. */
  overlay: ReactNode;
}

const CARD_PROMPTS = new Set(["idle", "battle", "selectChain", "selectCard", "selectTribute", "selectUnselect", "selectSum", "selectCounter", "selectPlace", "selectPosition"]);
const POS_LABEL: Record<Position, string> = { atk: "Attack", def: "Defense", faceDownDef: "Set (face-down Defense)", faceDown: "Face-down Attack" };
const PILE_TITLE: Record<string, string> = { deck: "Deck", gy: "GY", banished: "banished cards", extra: "Extra Deck", hand: "hand" };

/** Picker key: every pile with choices at once. */
const ALL_PILES = "*all";
/** A decision put to you (not your Main / Battle Phase actions or a position pop-up). */
const isDecisionKind = (p: EnginePrompt) => p.kind !== "idle" && p.kind !== "battle";
const sameZone = (a: EnginePlace, b: EnginePlace) => a.controller === b.controller && a.location === b.location && a.sequence === b.sequence;

export function useEngineBoard(o: EngineBoardOpts): EngineBoard {
  const { prompt, board, you } = o;
  const [picked, setPicked] = useState<number[]>([]);
  const [counts, setCounts] = useState<number[]>([]);
  const [places, setPlaces] = useState<EnginePlace[]>([]);
  const [showList, setShowList] = useState(false);
  // the decision dock can be minimized to look at the board (a pill brings it back); a new decision reopens it
  const [minimized, setMinimized] = useState(false);
  const promptId = prompt?.id;
  useEffect(() => { setMinimized(false); }, [promptId]);
  const [pile, setPile] = useState<string | null>(null);
  /** The picker this decision opened last: "Back to it" reopens it. */
  const [lastPile, setLastPile] = useState<string | null>(null);
  const point = useRef<{ x: number; y: number } | null>(null);
  /** Zone a hand card was dragged onto: answers the select-place prompt that usually follows. */
  const dropPlace = useRef<{ key: string; ttl: number } | null>(null);
  /** Monster a card was dragged onto in the Battle Phase: answers the attack-target prompt that follows. */
  const dropTarget = useRef<{ uid: string; ttl: number } | null>(null);
  const settings = useDuelSettings();

  const mine = prompt && prompt.player === you ? prompt : null;
  const send = (body: EngineResponseBody) => {
    if (!mine) return;
    setPile(null);
    o.respond({ ...body, promptId: mine.id } as EngineResponse);
  };

  const index = useMemo(() => indexBoard(board), [board]);
  const actions = useMemo(() => (mine ? actionsByUid(mine) : new Map<string, CardAction[]>()), [mine]);
  const items = useMemo<SelectItem[]>(() => (mine && isSelectPrompt(mine) ? selectItems(mine) : []), [mine]);
  const refs = useMemo<EngineCardRef[]>(() => {
    if (!mine) return [];
    if (isSelectPrompt(mine)) return items.map((i) => i.ref);
    if (mine.kind === "idle") return [...mine.summons, ...mine.specialSummons, ...mine.repositions, ...mine.monsterSets, ...mine.spellSets, ...mine.activates];
    if (mine.kind === "battle") return [...mine.attacks, ...mine.activates];
    if (mine.kind === "selectChain") return mine.cards;
    if (mine.kind === "effectYesNo") return [mine.card];
    return [];
  }, [mine, items]);
  const layout = useMemo(() => layoutRefs(refs, board), [refs, board]);
  const placeMap = useMemo(() => (mine?.kind === "selectPlace" ? placeKeys(mine, board) : new Map<string, EnginePlace>()), [mine, board]);
  const onBoardKind = !!mine && CARD_PROMPTS.has(mine.kind) && layout.missing.length === 0;

  // new prompt: reset picks; answer a zone choice the player already made by dropping a card
  useEffect(() => {
    setPicked([]);
    setPlaces([]);
    setShowList(false);
    setCounts(mine?.kind === "selectCounter" ? mine.cards.map(() => 0) : []);
    if (!mine) { setPile(null); return; }
    const d = dropPlace.current;
    if (d) {
      d.ttl--;
      if (mine.kind === "selectPlace" && mine.count === 1 && placeMap.has(d.key)) {
        dropPlace.current = null;
        o.respond({ kind: "selectPlace", places: [placeMap.get(d.key)!], promptId: mine.id });
        return;
      }
      if (d.ttl <= 0) dropPlace.current = null;
    }
    const t = dropTarget.current;
    if (t) {
      t.ttl--;
      if (mine.kind === "selectCard") {
        const it = selectItems(mine).find((x) => x.uid === t.uid);
        if (it) { dropTarget.current = null; o.respond({ kind: "selectCard", indices: [it.index], promptId: mine.id }); return; }
      }
      if (t.ttl <= 0) dropTarget.current = null;
    }
    // a zone choice for your own card on your own side: take the Extra Monster Zone, else the middle-most zone
    if (mine.kind === "selectPlace" && settings.autoPlace && !mine.disabling && mine.places.length >= mine.count && mine.places.every((x) => x.controller === you)) {
      const first = engineFirst(board);
      const rank = (x: EnginePlace) => (placeZone(x, first).zone === "extraMonster" ? -1 : Math.abs(x.sequence - 2));
      const best = [...mine.places].sort((a, b) => rank(a) - rank(b)).slice(0, mine.count);
      o.respond({ kind: "selectPlace", places: best, promptId: mine.id });
      return;
    }
    // everything to pick is in one pile (deck search, GY target, materials...): open it
    // ...or spread over several piles (Deck or GY, hand or Deck materials): open one picker with all of them
    const selecting = isSelectPrompt(mine) || mine.kind === "selectChain";
    const auto = selecting && layout.onBoard.size === 0 && layout.piles.size >= 1 ? (layout.piles.size === 1 ? [...layout.piles.keys()][0] : ALL_PILES) : null;
    setPile(auto);
    setLastPile(auto);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mine?.id]);

  const pickedSet = new Set(picked);
  const marks: BoardMarks = useMemo(() => {
    const m: BoardMarks = { actionable: new Set(), selectable: new Set(), picked: new Set(), places: new Set(), piles: new Map(), badges: new Map() };
    for (const [uid, link] of o.chainBadges ?? []) m.badges.set(uid, String(link));
    // the card whose effect is resolving (or was just activated) glows for everyone, whoever's turn or choice it is
    if (o.source && index.get(o.source.uid)?.card.code === o.source.code) m.source = o.source.uid;
    if (!mine) return m;
    if (mine.kind === "idle" || mine.kind === "battle") for (const uid of actions.keys()) m.actionable.add(uid);
    if (mine.kind === "idle" || mine.kind === "battle") {
      // what each card can do now (its glow and tag), and each pile's best (the Extra Deck: Summon)
      m.can = new Map();
      for (const [uid, acts] of actions) { const k = canOf(acts); if (k) m.can.set(uid, k); }
      for (const [key, list] of layout.piles) {
        const kinds = list.map((r) => m.can!.get(refUid(r))).filter(Boolean) as CanKind[];
        const best = CAN_ORDER.find((k) => kinds.includes(k));
        if (best) m.can.set(key, best);
      }
    }
    if (mine.kind === "battle" && settings.dragAttack) m.drag = new Set(mine.attacks.map((r) => refUid(r)));
    if (mine.kind === "selectChain") for (const uid of actions.keys()) m.selectable.add(uid);
    if (mine.kind === "effectYesNo") m.selectable.add(refUid(mine.card));
    for (const it of items) {
      if (it.fixed || pickedSet.has(it.index)) m.picked.add(it.uid);
      else m.selectable.add(it.uid);
      if (mine.kind === "selectCounter" && counts[it.index]) m.badges.set(it.uid, `−${counts[it.index]}`);
    }
    if (mine.kind === "selectPlace") for (const [k, v] of placeMap) if (!places.some((p) => sameZone(p, v))) m.places.add(k);
    for (const [k, list] of layout.piles) m.piles.set(k, list.length);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mine, actions, items, picked, counts, places, placeMap, layout, o.chainBadges, settings.dragAttack, o.source, index]);

  // ---------- look at the board mid-decision, then come back ----------
  const isDecision = !!mine && isDecisionKind(mine);
  const peeking = isDecision && (minimized || (!!lastPile && !pile));
  const peek = () => { setPile(null); setMinimized(true); };
  const restore = () => { setMinimized(false); if (lastPile && (lastPile === ALL_PILES || layout.piles.has(lastPile.replace(CAN_ONLY, "")))) setPile(lastPile); };

  // ---------- clicks ----------

  const viewItem = (card: CardInstance): MenuItem[] => {
    const out: MenuItem[] = [];
    if (card.code > 0) out.push({ label: "View card", run: () => o.preview(card.code) });
    if (card.materials?.length) out.push({ label: `Xyz materials (${card.materials.length})`, run: () => o.showMaterials(card.uid) });
    return out;
  };
  const nameOf = (card: CardInstance) => (card.code > 0 ? o.cardName(card.code) ?? `Card ${card.code}` : "Face-down card");

  const pickItem = (it: SelectItem) => {
    if (!mine || !isSelectPrompt(mine)) return;
    sfx("pick");
    if (mine.kind === "selectUnselect") return send({ kind: "selectUnselect", index: it.index });
    if (it.fixed) return;
    if (mine.kind === "selectCounter") {
      setCounts((cs) => cs.map((c, i) => (i === it.index ? (c + 1) % ((it.available ?? 0) + 1) : c)));
      return;
    }
    if (answersOnClick(mine)) return send({ kind: "selectCard", indices: [it.index] });
    setPicked((ps) => (ps.includes(it.index) ? ps.filter((x) => x !== it.index) : [...ps, it.index]));
  };

  const onCard = (card: CardInstance, at: ZoneRef, e: MouseEvent) => {
    point.current = { x: e.clientX, y: e.clientY };
    if (peeking && marks.source === card.uid) { restore(); return; }
    if (mine?.kind === "selectPlace") {
      const k = zoneKey(at);
      if (placeMap.has(k)) return choosePlace(placeMap.get(k)!);
    }
    if (mine && isSelectPrompt(mine)) {
      const it = items.find((x) => x.uid === card.uid && !(x.fixed && mine.kind === "selectSum"));
      if (it) return pickItem(it);
    }
    const acts = actions.get(card.uid);
    const menu: MenuItem[] = [...(acts ?? []).map((a) => ({ label: a.label, run: () => send(a.response) })), ...viewItem(card)];
    if (menu.length) o.openMenu({ x: e.clientX, y: e.clientY, title: nameOf(card), items: menu });
  };

  const choosePlace = (p: EnginePlace) => {
    if (!mine || mine.kind !== "selectPlace") return;
    sfx("pick");
    const next = places.some((x) => sameZone(x, p)) ? places.filter((x) => !sameZone(x, p)) : [...places, p];
    if (next.length >= mine.count) send({ kind: "selectPlace", places: next.slice(0, mine.count) });
    else setPlaces(next);
  };

  const onZone = (at: ZoneRef, e: MouseEvent): boolean => {
    point.current = { x: e.clientX, y: e.clientY };
    const k = zoneKey(at);
    if (mine?.kind === "selectPlace" && placeMap.has(k)) { choosePlace(placeMap.get(k)!); return true; }
    if (layout.piles.has(k) && (mine?.kind === "idle" || mine?.kind === "battle") && PILE_ZONES.has(at.zone)) {
      // a pile with something to do (the Extra Deck: Special Summon): do it, or look through the whole pile
      const n = layout.piles.get(k)!.length;
      const kind = marks.can?.get(k);
      const verb = at.zone === "extra" || kind === "summon" ? "Special Summon" : kind === "attack" ? "Attack" : "Activate";
      const total = board.players[at.player][at.zone as "deck" | "gy" | "banished" | "extra"].length;
      const publicPile = at.zone !== "deck";
      o.openMenu({ x: e.clientX, y: e.clientY, title: PILE_TITLE[at.zone as keyof typeof PILE_TITLE] ?? "Pile", items: [
        { label: `${verb}… (${n} ${n === 1 ? "card" : "cards"})`, run: () => { setPile(`${k}${CAN_ONLY}`); setLastPile(`${k}${CAN_ONLY}`); } },
        ...(publicPile ? [{ label: `View all (${total})`, run: () => { setPile(k); setLastPile(k); } }] : []),
      ] });
      return true;
    }
    if (layout.piles.has(k)) { setPile(k); setLastPile(k); return true; }
    // a pile click opens its viewer (GY / banished / Extra); nothing else on the board does anything by itself
    return !(at.zone === "gy" || at.zone === "banished" || at.zone === "extra");
  };

  const onDrop = (at: ZoneRef, uid: string, e: DragEvent) => {
    point.current = { x: e.clientX, y: e.clientY };
    // drag-to-attack: your monster dropped on the opponent's side declares the attack (on that monster, if any)
    if (mine?.kind === "battle") {
      const atk = actions.get(uid)?.find((a) => a.response.kind === "battle" && a.response.action === "attack");
      const k = zoneKey(at);
      const target = [...index.values()].find((l) => !l.host && zoneKey(l.at) === k && (l.at.zone === "monster" || l.at.zone === "extraMonster"))?.card;
      const theirs = target ? (target.controller ?? target.owner) !== you : at.zone !== "extraMonster" && at.player !== you;
      if (!atk || !theirs) { if (atk) o.toast("Drop it on an opponent's monster (or their side) to attack."); return; }
      dropTarget.current = target ? { uid: target.uid, ttl: 3 } : null;
      return send(atk.response);
    }
    const choices = dropChoices(actions.get(uid), at.zone);
    if (!choices.length) { if (actions.get(uid)) o.toast("That card can't be played there."); return; }
    dropPlace.current = { key: zoneKey(at), ttl: 3 };
    if (choices.length === 1) return send(choices[0].response);
    o.openMenu({ x: e.clientX, y: e.clientY, title: o.cardName(index.get(uid)?.card.code ?? 0) ?? "Play card", items: choices.map((a) => ({ label: a.label, run: () => send(a.response) })) });
  };

  // ---------- phase bar ----------

  const phase: PhaseActions = {};
  if (mine?.kind === "idle") {
    if (mine.canBattle) phase.battle = () => send({ kind: "idle", action: "battle" });
    if (mine.canEnd) phase.end = () => send({ kind: "idle", action: "end" });
    if (mine.canShuffle) phase.shuffle = () => send({ kind: "idle", action: "shuffle" });
  } else if (mine?.kind === "battle") {
    if (mine.canMain2) phase.main2 = () => send({ kind: "battle", action: "main2" });
    if (mine.canEnd) phase.end = () => send({ kind: "battle", action: "end" });
  }

  const status = !mine ? null
    : mine.kind === "idle" ? (mine.hint ?? `Your ${board.phase === "main2" ? "Main Phase 2" : "Main Phase"}: click a highlighted card to play it${actions.size ? "" : " (nothing to play right now)"}, or use the phase buttons.`)
    : mine.kind === "battle" ? (mine.hint ?? "Battle Phase: click a highlighted monster to attack, or move on with the phase buttons.")
    : "Your move: choose on the board.";

  // ---------- keyboard: Enter confirms, Esc cancels / passes, Space ends the turn or passes ----------

  const onKey = useRef<(e: KeyboardEvent) => void>(() => undefined);
  onKey.current = (e: KeyboardEvent) => {
    if (!mine || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement;
    if (t.closest?.("input, textarea, select") || document.querySelector(".duel-menu")) return;
    const sel = isSelectPrompt(mine) ? mine : null;
    let r: EngineResponseBody | null = null;
    if (e.key === "Enter") {
      if (t.closest?.("button")) return;   // let the focused button do its own thing
      if (sel && !answersOnClick(sel)) r = selectResponse(sel, picked, counts);
      else if (sel?.kind === "selectUnselect" && sel.canFinish) r = { kind: "selectUnselect", index: null };
    } else if (e.key === "Escape") {
      if (pile) { setPile(null); return; }
      if ((mine.kind === "selectCard" || mine.kind === "selectTribute") && mine.canCancel) r = { kind: mine.kind, indices: null };
      else if (mine.kind === "selectUnselect" && mine.canCancel && !mine.canFinish) r = { kind: "selectUnselect", index: null };
      else if (mine.kind === "selectChain" && !mine.forced) r = { kind: "selectChain", index: null };
      else if (picked.length || places.length) { setPicked([]); setPlaces([]); return; }
    } else if (e.key === "m" || e.key === "M") {
      if (mine.kind !== "idle" && mine.kind !== "battle") { e.preventDefault(); if (peeking) restore(); else peek(); }
      return;
    } else if (e.key === " ") {
      if (t.closest?.("button")) return;
      if (mine.kind === "selectChain" && !mine.forced) r = { kind: "selectChain", index: null };
      else if (phase.end) { e.preventDefault(); phase.end(); return; }
    }
    if (r) { e.preventDefault(); send(r); }
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => onKey.current(e);
    addEventListener("keydown", h);
    return () => removeEventListener("keydown", h);
  }, []);

  // ---------- overlay ----------

  let overlay: ReactNode = null;
  if (mine) {
    const panel = <EnginePromptPanel prompt={mine} onRespond={o.respond} cardName={o.cardName} onHover={o.onHover} info={(code) => <CardCaption code={code} />} />;
    if (!onBoardKind || showList) {
      overlay = (
        <div className="duel-engine-dialog" role="dialog" aria-label="Rules engine choice">
          {panel}
          {showList && <button className="duel-engine-dialog-back" onClick={() => setShowList(false)}>Back to the board</button>}
        </div>
      );
    } else if (mine.kind === "selectPosition") {
      overlay = <PositionChooser prompt={mine} at={point.current} name={o.cardName(mine.code)} you={o.you} onPick={(position) => send({ kind: "selectPosition", position })} />;
    } else if (mine.kind !== "idle" && mine.kind !== "battle") {
      const hintText = mine.hint ?? title(mine);
      overlay = minimized
        ? <button className="duel-decision-pill" onClick={restore} title="Back to the current decision (M)">▸ Back to: {o.source ? `${o.cardName(o.source.code) ?? "the effect"} · ` : ""}{hintText} <kbd>M</kbd></button>
        : <PromptBar prompt={mine} picked={picked} counts={counts} places={places} send={send} onList={() => setShowList(true)} cardName={o.cardName} onHover={o.onHover} onMinimize={() => setMinimized(true)} />;
    }
    const pv = pile ? pileView(pile) : null;
    if (pv) {
      overlay = (
        <>
          {overlay}
          <Modal title={pv.title} onClose={() => setPile(null)} wide docked>
            <p className="muted duel-engine-pilehint">{mine.hint ?? title(mine)}</p>
            {pv.sections.map((sec) => (
              <div key={sec.label || "pile"} className="duel-picker-section">
                {sec.label && <h4 className="duel-picker-label">{sec.label}</h4>}
                <div className="duel-viewer-grid">
                  {sec.cards.map(({ card, at }) => {
                    const mark = marks.picked.has(card.uid) ? "picked" : marks.selectable.has(card.uid) ? "selectable" : marks.actionable.has(card.uid) ? "actionable" : undefined;
                    return (
                      <div key={card.uid} className="duel-viewer-cell">
                        <CardView card={{ ...card, faceUp: card.faceUp || card.code > 0 }} mark={mark} can={marks.can?.get(card.uid)} badge={marks.badges.get(card.uid)}
                          onHover={o.onHover} onClick={(e) => onCard(card, at, e)} />
                        <CardCaption code={card.code} name />
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
            <div className="duel-modal-actions">
              <button onClick={peek} title="Hide this to look at the board; the glowing card (or the pill) brings it back (M)">👁 View board</button>
              <button onClick={() => setPile(null)}>Close</button>
            </div>
          </Modal>
        </>
      );
    }
  }

  /** Cards to show for a pile: the whole public pile, or only the prompt's cards where the pile is hidden. */
  function pileView(key: string): { title: string; sections: { label: string; cards: { card: CardInstance; at: ZoneRef }[] }[] } | null {
    if (key === ALL_PILES) {
      // every pile with choices, only the cards you can pick
      const sections = [...layout.piles.keys()].map((k) => {
        const v = onePile(k);
        const cards = (v?.cards ?? []).filter(({ card }) => marks.selectable.has(card.uid) || marks.picked.has(card.uid) || marks.actionable.has(card.uid));
        return { label: v?.title ?? k, cards };
      }).filter((s) => s.cards.length);
      const n = sections.reduce((t, s) => t + s.cards.length, 0);
      return { title: `${n} to choose from`, sections };
    }
    if (key.endsWith(CAN_ONLY)) {
      // only the cards you can use now
      const v = onePile(key.slice(0, -CAN_ONLY.length));
      if (!v) return null;
      const cards = v.cards.filter(({ card }) => marks.actionable.has(card.uid) || marks.selectable.has(card.uid));
      const verb = key.includes("extra") ? "Special Summon" : "Use";
      return { title: `${verb}: ${cards.length} ${cards.length === 1 ? "card" : "cards"}`, sections: [{ label: "", cards }] };
    }
    const v = onePile(key);
    // the Main / Battle Phase "View all": the whole pile, the usable cards glowing
    const browsing = mine?.kind === "idle" || mine?.kind === "battle";
    return v && { title: browsing ? v.title.replace(/: \d+ to choose from$/, `: ${v.cards.length}`) : v.title, sections: [{ label: "", cards: v.cards }] };
  }
  function onePile(key: string): { title: string; cards: { card: CardInstance; at: ZoneRef }[] } | null {
    const list = layout.piles.get(key);
    if (!list) return null;
    const r0 = list[0];
    const whose = r0.controller === you ? "Your" : "Opponent's";
    if (r0.location === "overlay") {
      const host = index.get(refUid({ ...r0, location: "monster" }));
      const mats = host?.card.materials ?? [];
      return { title: `Xyz materials of ${host ? nameOf(host.card) : "a monster"}`, cards: mats.map((card) => ({ card, at: host!.at })) };
    }
    const zone = r0.location as "deck" | "gy" | "banished" | "extra";
    const pileCards = board.players[r0.controller][zone];
    const publicPile = zone === "gy" || zone === "banished" || (zone === "extra" && r0.controller === you);
    const cards = publicPile
      ? pileCards.map((card, slot) => ({ card, at: { zone, player: r0.controller, slot } as ZoneRef })).reverse()
      : list.map((r) => ({
        card: { uid: refUid(r), code: visibleCode(r, you, board, index), owner: r.controller, faceUp: true } as CardInstance,
        at: { zone, player: r.controller } as ZoneRef,
      }));
    return { title: `${whose} ${PILE_TITLE[zone]}: ${list.length} to choose from`, cards };
  }

  /** Hover buttons: a card's Main / Battle Phase actions, one click each (no menu). */
  const quick = (uid: string) => (mine && (mine.kind === "idle" || mine.kind === "battle") ? (actions.get(uid) ?? []).map((a) => ({ label: a.label, run: () => send(a.response) })) : []);
  return { marks, onCard, onZone, onDrop, phase, status, overlay, yourMove: !!mine, quick, decision: isDecision ? { peeking, peek, restore } : null };
}

// ---------------------------------------------------------------------------------------

type BarPrompt = Exclude<EnginePrompt, { kind: "idle" | "battle" | "selectPosition" }>;

/** The compact floating bar for selections: what to pick, progress, Confirm / Cancel / Don't chain. */
function PromptBar({ prompt: p, picked, counts, places, send, onList, cardName, onHover, onMinimize }: {
  prompt: BarPrompt; picked: number[]; counts: number[]; places: EnginePlace[];
  send(r: EngineResponseBody): void; onList(): void; cardName(code: number): string | undefined; onHover(code: number | null): void; onMinimize(): void;
}) {
  usePageFlag("engine-bar");
  const hint = p.hint ?? title(p);
  let progress: string | null = null;
  const buttons: ReactNode[] = [];
  if (isSelectPrompt(p)) {
    const st = selectStatus(p, picked, counts);
    progress = st.label;
    if (!answersOnClick(p)) {
      const res = selectResponse(p, picked, counts);
      buttons.push(<button key="ok" className="primary" disabled={!res} onClick={() => res && send(res)}>Confirm <kbd>Enter</kbd></button>);
    }
    if (p.kind === "selectUnselect" && (p.canFinish || p.canCancel)) {
      buttons.push(<button key="done" className={p.canFinish ? "primary" : "is-back"} onClick={() => send({ kind: "selectUnselect", index: null })}>{p.canFinish ? <>Done <kbd>Enter</kbd></> : <>← Cancel <kbd>Esc</kbd></>}</button>);
    }
    if ((p.kind === "selectCard" || p.kind === "selectTribute") && p.canCancel) {
      buttons.push(<button key="cancel" className="is-back" onClick={() => send({ kind: p.kind, indices: null })}>← Cancel <kbd>Esc</kbd></button>);
    }
  } else if (p.kind === "selectChain") {
    if (!p.forced) buttons.push(<button key="no" className="primary" onClick={() => send({ kind: "selectChain", index: null })}>Don't chain <kbd>Esc</kbd></button>);
  } else if (p.kind === "selectPlace") {
    progress = p.count > 1 ? `${places.length}/${p.count}` : null;
  }
  const canBack = (p.kind === "selectChain" && !p.forced)
    || ((p.kind === "selectCard" || p.kind === "selectTribute") && p.canCancel)
    || (p.kind === "selectUnselect" && (p.canCancel || p.canFinish));
  // the chain pop-up: every card you could chain, with the effect it would activate; one click chains it
  const chainOptions = p.kind === "selectChain" ? p.cards : [];
  return (
    <div className={`duel-engine-bar ${p.kind === "selectChain" ? "is-chain" : ""}`} role="status" aria-live="polite">
      <span className="duel-engine-bar-top">
        <span className="duel-engine-bar-kicker">{p.kind === "selectChain" ? (p.forced ? "Activate an effect" : "Your chance to respond") : "Your decision"}</span>
        <button className="duel-engine-bar-min" onClick={onMinimize} title="Minimize to look at the board (M)" aria-label="Minimize">–</button>
      </span>
      <span className="duel-engine-bar-hint">{p.kind === "selectChain" ? `${hint}` : p.kind === "selectPlace" ? (p.hint && !/^Select/.test(p.hint) ? `${p.hint}: choose a zone on the board.` : `${hint}. Click a highlighted zone.`) : hint}</span>
      {progress && <span className="duel-engine-bar-count">{progress}</span>}
      {chainOptions.length > 0 && (
        <ul className="duel-chain-options">
          {chainOptions.map((c, i) => (
            <li key={i}>
              <button onClick={() => send({ kind: "selectChain", index: i })} title={c.desc || cardName(c.code)}
                onMouseEnter={() => onHover(c.code || null)} onMouseLeave={() => onHover(null)} onFocus={() => onHover(c.code || null)} onBlur={() => onHover(null)}>
                <span className="duel-card duel-chain-thumb"><span className="duel-card-inner"><CardFace code={c.code} /></span></span>
                <span className="duel-chain-text"><b>{cardName(c.code) ?? "Card"}</b><small>{c.desc || "Activate"}{c.from ? <em className="duel-granted"> · from {cardName(c.from) ?? "another card"}</em> : null}</small></span>
                <span className="duel-chain-go">Chain ›</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <span className="duel-engine-bar-buttons">
        {buttons}
        {!canBack && <small className="duel-engine-bar-noback" title="The rules engine needs this choice to continue">This step can't be undone: finish it on the board.</small>}
        <button className="duel-engine-bar-list" onClick={onList} title="Show this choice as a list">List</button>
      </span>
    </div>
  );
}

/** Battle position chooser, next to where the player last clicked (centred otherwise). */
function PositionChooser({ prompt: p, at, name, you, onPick }: {
  prompt: Extract<EnginePrompt, { kind: "selectPosition" }>; at: { x: number; y: number } | null; name?: string; you: Seat; onPick(p: Position): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !at || innerWidth <= 600) { setPos(null); return; }
    const r = el.getBoundingClientRect();
    setPos({ left: toCss(Math.max(8, Math.min(at.x - r.width / 2, innerWidth - r.width - 8))), top: toCss(Math.max(8, Math.min(at.y - r.height - 12, innerHeight - r.height - 8))) });
  }, [at, p.id]);
  useEffect(() => { ref.current?.querySelector("button")?.focus(); }, [p.id]);
  return (
    <div ref={ref} className={`duel-engine-pos ${pos ? "" : "is-centred"}`} style={pos ?? undefined} role="dialog" aria-label="Choose a battle position">
      <div className="duel-engine-pos-title">{p.hint ?? `${name ?? "Card"}: choose a position`}</div>
      <div className="duel-engine-pos-row">
        {p.positions.map((x) => (
          <button key={x} onClick={() => onPick(x)} title={POS_LABEL[x]}>
            <span className={`duel-card ${x === "def" || x === "faceDownDef" ? "is-def" : ""}`}>
              <span className="duel-card-inner">{x === "faceDownDef" || x === "faceDown" ? <CardBack owner={you} /> : <CardFace code={p.code} />}</span>
            </span>
            <span>{POS_LABEL[x]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** A pile key suffix: the picker shows only the cards you can use now. */
const CAN_ONLY = "|can";
const PILE_ZONES = new Set(["deck", "gy", "banished", "extra"]);
/** Strongest first: a card that can be summoned and Set glows as summonable. */
const CAN_ORDER: CanKind[] = ["summon", "activate", "attack", "set"];
function canOf(acts: CardAction[]): CanKind | null {
  const kinds = new Set<CanKind>();
  for (const a of acts) {
    const r = a.response as { action?: string };
    if (r.action === "summon" || r.action === "specialSummon" || /Flip Summon/.test(a.label)) kinds.add("summon");
    else if (r.action === "activate") kinds.add("activate");
    else if (r.action === "attack") kinds.add("attack");
    else if (r.action === "monsterSet" || r.action === "spellSet") kinds.add("set");
  }
  return CAN_ORDER.find((k) => kinds.has(k)) ?? null;
}
