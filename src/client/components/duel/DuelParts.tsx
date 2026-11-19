// Pieces of the duel page: the LP / player plates, the phase cells, the turn sign, the decision panel,
// the "More" popover, whose move it is, and the change-LP dialog (manual duels).
import { Suspense, lazy, useSyncExternalStore, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { newDeck, useDeckStore } from "../../store/deckStore.ts";
import { isStarterDeck } from "../../../shared/starterDecks.ts";
import type { Deck } from "../../../shared/types.ts";
import { Link, useParams, useSearchParams } from "react-router-dom";
import type { BoardState, CardInstance, TurnClock } from "../../../shared/duel.ts";
import type { EngineCardRef, EngineEvent, EnginePrompt, EngineResponse } from "../../../shared/enginePrompts.ts";
import { enginePhaseControls, enginePhaseResponse, manualPhaseControls, type PhaseControls } from "../../../shared/phases.ts";
import { PHASE_LABEL, type DuelAction, type Phase, type Seat } from "../../../shared/duelActions.ts";
import { Board, PendulumStrip, type BoardUI, type Matchup, type ZoneRef } from "./Board.tsx";
import { indexBoard, refUid } from "../engine/boardRefs.ts";
import { attackOutcome } from "../../../shared/matchup.ts";
import { CardFace, CardView } from "./CardView.tsx";
import { useDecks } from "./DeckPicker.tsx";
import { buildMenu, dropAction, locate, occupantAt, pileMenu, type MenuItem, type Pending } from "./menus.ts";
import { ContextMenu, Modal, Toasts } from "./Overlays.tsx";
import { PreDuel } from "./PreDuel.tsx";
import { CardPreview, LogChat, LogText } from "./SidePanel.tsx";
import { boardCodes, getCard, useCardData, useDuelIdentity, useDuelSocket } from "./useDuel.ts";
import { AnimatedLp } from "./anim/AnimatedLp.tsx";
import { useBoardAnimations } from "./anim/useBoardAnimations.ts";
import { getBusVolume, getSoundTheme, isMuted, onMuteChange, play as sfx, setMusic } from "./anim/sfx.ts";
import { EndOverlay, MuteToggle, ReconnectOverlay, TurnBanner } from "./DuelFx.tsx";
import { useEngineBoard, type Decision } from "../engine/EngineBoard.tsx";
import { ClockFace, SecondsText, TurnTimer } from "./TurnTimer.tsx";
import { SkinPicker } from "../SkinPicker.tsx";
import { DuelSettingsButton } from "./DuelSettingsPanel.tsx";
import { ChainStack } from "./ChainStack.tsx";
import { duelSettings, useDuelSettings } from "./duelSettings.ts";
import { SPEEDS, setAutopilot, setSpeed, useAutopilot, type Speed } from "./autopilot.ts";
import { botResponse } from "../../../worker/duel/engine/bot.ts";
import { demoDeck } from "../../../shared/starterDecks.ts";
import { AUTO_PASS_LABEL, autoAnswer, type AutoPassMode } from "../../../shared/autoPass.ts";
import { nothingLeftToDo } from "../../../shared/turnFlow.ts";
import { ShortcutSheet, ShortcutsButton, useKeyboardCursor } from "./Shortcuts.tsx";
import { RarityContext, rarityLookup, useFoilPointer } from "../cards/Rarity.tsx";
import { SleeveContext } from "./Sleeve.tsx";
import { DuelLog, useRailFit } from "./DuelLog.tsx";
import { useUiScale } from "./uiScale.ts";
import { useHtmlClasses, usePageFlag } from "./pageFlag.ts";
import { ReplayRecorder, saveReplay } from "./replay.ts";
import { DuelStats } from "./DuelStats.tsx";
import { avatarStyle, getProfile } from "./profileStore.ts";
import type { Profile } from "../../../shared/profile.ts";
import { RevealStrip, useReveals } from "./RevealStrip.tsx";

export function PlayerBar({ board, player, you, onLp, onLpChange, connected, timer, startLp = 8000, duelNo = 0, profile }: {
  board: NonNullable<ReturnType<typeof useDuelSocket>["conn"]["board"]>; player: Seat; you: Seat | null;
  timer?: TurnClock; startLp?: number; duelNo?: number; profile?: Profile;
  /** Manual mode: click the LP to change it (rules-enforced LP only change through the rules). */
  onLp?: (p: Seat) => void; onLpChange?: (delta: number) => void; connected?: boolean;
}) {
  const pb = board.players[player];
  const turn = board.turnPlayer === player;
  const [hit, setHit] = useState<"" | "is-hit" | "is-heal">("");
  const lpChanged = (d: number) => {
    onLpChange?.(d);
    setHit(d < 0 ? "is-hit" : "is-heal");
    setTimeout(() => setHit(""), 650);
  };
  return (
    <div className={`duel-playerbar ${turn ? "is-turn" : ""} ${player === you ? "is-you" : ""} ${hit}`} data-seat={player}>
      <span className={`duel-avatar ${profile?.avatar ? "has-art" : ""}`} style={avatarStyle(profile)} aria-hidden="true" title={profile?.title}>
        {(pb.name.trim()[0] ?? "?").toUpperCase()}
        <span className={`duel-dot ${connected === false ? "is-off" : "is-on"}`} title={connected === false ? "Disconnected" : "Connected"} />
      </span>
      <span className="duel-pinfo">
        <b className="duel-pname">{pb.name}{player === you ? " (you)" : ""}</b>
        <span className="muted duel-pcounts">
          <span title="Cards in hand">✋ {pb.hand.length}</span>
          <span title="Cards in Deck">🂠 {pb.deck.length}</span>
          {turn && <span className="duel-chip is-turn">Turn {board.turn}</span>}
        </span>
      </span>
      <button className={`duel-lp ${pb.lp <= 2000 ? "is-low" : ""}`} onClick={onLp ? () => onLp(player) : undefined} disabled={you === null || !onLp} title={onLp ? "Change LP" : "Life Points"}>
        <span>LP</span> <AnimatedLp key={duelNo} value={pb.lp} onChange={lpChanged} />
      </button>
      {/* their clock, right beside the LP (outside the stats line, which fades back in calm mode) */}
      {timer && <span className="duel-timer-slot"><TurnTimer timer={timer} seat={player} label={player === you ? "Your time" : `${pb.name}'s time`} /></span>}
    </div>
  );
}

export const PHASE_SHORT: Record<Phase, string> = { draw: "DP", standby: "SP", main1: "M1", battle: "BP", main2: "M2", end: "EP" };
export const PHASE_SHORT_LABEL = PHASE_SHORT;

/** Some of the phases, as big buttons in an empty cell of the middle row (DP SP | M1 BP M2 | EP + End turn). */
export function PhaseCell({ controls, go, phases, endTurn }: { controls: PhaseControls; go(target: Phase | "endTurn"): void; phases: Phase[]; endTurn?: boolean }) {
  return (
    <div className="duel-phasecell" role="group">
      {controls.phases.filter((p) => phases.includes(p.phase)).map((p) => (
        <button key={p.phase} className={`duel-phasebtn ${p.current ? "is-active" : ""} ${p.past ? "is-past" : ""} ${p.enabled ? "is-next" : ""} ${controls.next === p.phase ? "duel-next-phase" : ""}`}
          disabled={!p.enabled} title={`${PHASE_LABEL[p.phase]}: ${p.hint}${controls.next === p.phase ? " (N)" : ""}`} onClick={() => go(p.phase)}>
          {PHASE_SHORT_LABEL[p.phase]}
        </button>
      ))}
      {endTurn && (
        <button className="primary duel-end-turn duel-phasecell-end" disabled={!controls.endTurn.enabled} onClick={() => go("endTurn")} title={`${controls.endTurn.hint} (E)`}>End turn</button>
      )}
    </div>
  );
}

/** The nearest element between `el` and the board that scrolls on its own (has overflow to scroll). */
export function scrollableAncestor(el: HTMLElement | null): HTMLElement | null {
  for (let n = el; n && !n.classList.contains("duel-board-wrap") && n !== document.body; n = n.parentElement) {
    const o = getComputedStyle(n).overflowY;
    if ((o === "auto" || o === "scroll") && n.scrollHeight > n.clientHeight + 2) return n;
  }
  return null;
}

/** "Bot is choosing: Select the card(s) to add to your hand" (or deciding whether to chain). */
export function decidingText(d: { seat: 0 | 1; kind: string; hint?: string } | undefined, names: [string, string], fallback: string): string {
  if (!d) return `Waiting for ${fallback}…`;
  const who = names[d.seat];
  if (d.kind === "selectChain") return `${who} may respond (chain)…`;
  if (d.kind === "idle") return `${who} is in their Main Phase…`;
  if (d.kind === "battle") return `${who} is in their Battle Phase…`;
  if (d.hint) return `${who} is choosing: ${d.hint}`;
  // no public hint (it would name a hidden card): say what kind of choice it is
  const what: Record<string, string> = {
    selectPlace: "a zone", selectPosition: "a battle position", selectCard: "cards", selectTribute: "Tributes", selectSum: "materials",
    selectUnselect: "cards", selectCounter: "counters", effectYesNo: "whether to use an effect", yesNo: "yes or no", option: "an option",
    sort: "an order", announceNumber: "a number", announceRace: "a Type", announceAttribute: "an Attribute", announceCard: "a card name", rps: "rock, paper or scissors",
  };
  return what[d.kind] ? `${who} is choosing ${what[d.kind]}…` : `${who} is deciding…`;
}

/** Bottom right: whose turn it is, beating like a heart when it's yours (or when it's your move on their turn). */
export function TurnSign({ board, you, names, acting, waiting, timer }: { board: BoardState; you: Seat | null; names: [string, string]; acting: boolean; waiting: string | null; timer?: TurnClock }) {
  const mine = board.turnPlayer === you;
  const theirMove = acting && !mine;
  // your turn, but the opponent is the one deciding (a response, a target): the sign names them
  // (timed duels go by whose clock runs, so the engine thinking between your moves doesn't flip it)
  const theirsNow = mine && !acting && !!waiting && (!timer || (timer.running !== null && timer.running !== you));
  const cls = theirMove ? "is-acting" : theirsNow ? "is-theirs" : mine ? (acting ? "is-mine" : "is-mine is-waiting") : "is-theirs";
  const text = theirMove ? "Your move" : theirsNow ? `${waiting}'s turn` : mine ? "Your turn" : `${names[board.turnPlayer]}'s turn`;
  return (
    <div className="duel-turnrow">
      {/* the clock of whoever the duel waits on: it passes back and forth with the decisions */}
      {timer && (() => {
        const seat = (timer.running ?? board.turnPlayer) as 0 | 1;
        return <ClockFace timer={timer} seat={seat} mine={seat === you} label={seat === you ? "your time" : `${names[seat]}'s time`} />;
      })()}
      <div className={`duel-turnsign ${cls}`} role="status" aria-live="polite">
        {/* timed duels: the letters are the seconds bar of whoever is deciding */}
        {timer
          ? <SecondsText timer={timer} seat={(timer.running ?? board.turnPlayer) as 0 | 1}>{text}</SecondsText>
          : <b>{text}</b>}
      </div>
    </div>
  );
}

/** What you're deciding right now, and for which card: step back to look at the board, then return. */
export function NowPanel({ decision, prompt, source, onHover }: { decision: Decision; prompt: EnginePrompt | null; source: { code: number; desc: string } | null; onHover(code: number | null): void }) {
  usePageFlag("peeking", !!prompt && decision.peeking);
  if (!prompt) return null;
  const name = source?.code ? getCard(source.code)?.name : null;
  return (
    <div className={`duel-now ${decision.peeking ? "is-peeking" : ""}`} onMouseEnter={() => source?.code && onHover(source.code)} onMouseLeave={() => onHover(null)}>
      {source?.code ? <span className="duel-card duel-now-thumb"><span className="duel-card-inner"><CardFace code={source.code} /></span></span> : null}
      <span className="duel-now-text">
        <small>{prompt.kind === "selectChain" ? "Your chance to respond" : name ? "Resolving" : "Your decision"}</small>
        {name && <b>{name}</b>}
        <span>{prompt.hint ?? (prompt.kind === "selectChain" ? "Chain a card or effect?" : "Choose on the board")}</span>
      </span>
      {decision.peeking
        ? <button className="primary duel-now-btn" onClick={decision.restore} title="Back to the decision (M)">Back to it <kbd>M</kbd></button>
        : <button className="duel-now-btn" onClick={decision.peek} title="Hide the decision to look at the board (M)">👁 View board</button>}
    </div>
  );
}

/** The less common tools (Shuffle hand, manual-mode Draw / Coin / ..., Concede on phones), in a pop-up. */
export function MorePopover({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close as EventListener);
    window.addEventListener("keydown", close as EventListener);
    return () => { window.removeEventListener("mousedown", close as EventListener); window.removeEventListener("keydown", close as EventListener); };
  }, [open]);
  return (
    <div className="duel-more" ref={ref}>
      <button className="duel-more-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>⋯ More</button>
      {open && <div className="duel-tools duel-more-panel" onClick={(e) => { if ((e.target as HTMLElement).closest("button")) setOpen(false); }}>{children}</div>}
    </div>
  );
}

/** Whose decision it is (left of the phase track). */
export function MoveStatus({ board, you, move }: { board: BoardState; you: Seat | null; move?: { mine: boolean; text: string } | null }) {
  const mine = board.turnPlayer === you;
  return move ? <span className={`duel-move ${move.mine ? "is-mine" : "is-wait"}`} role="status">{move.text}</span>
    : <span className="duel-move is-wait">{mine ? "Your turn" : `${board.players[board.turnPlayer].name}'s turn`}</span>;
}

export function LpDialog({ board, initial, you, onClose, act }: { board: NonNullable<ReturnType<typeof useDuelSocket>["conn"]["board"]>; initial: Seat; you: Seat | null; onClose(): void; act(a: DuelAction): void }) {
  const [player, setPlayer] = useState<Seat>(initial);
  const [amount, setAmount] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, []);
  const n = Math.trunc(Number(amount));
  const ok = Number.isFinite(n) && n > 0;
  const go = (a: DuelAction) => { act(a); onClose(); };
  const lp = board.players[player].lp;
  const quick = useMemo(() => [500, 1000, 2000], []);
  if (you === null) return null;
  return (
    <Modal title="Change LP" onClose={onClose}>
      <div className="duel-lpdialog">
        <div className="duel-seg" role="radiogroup">
          {([0, 1] as Seat[]).map((p) => (
            <button key={p} role="radio" aria-checked={player === p} className={player === p ? "is-active" : ""} onClick={() => setPlayer(p)}>
              {board.players[p].name}{p === you ? " (you)" : ""}: {board.players[p].lp}
            </button>
          ))}
        </div>
        <form onSubmit={(e) => { e.preventDefault(); if (ok) go({ type: "lp", player, delta: -n }); }}>
          <input ref={inputRef} inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ""))} placeholder="Amount" aria-label="LP amount" />
          <div className="duel-lp-actions">
            <button type="submit" className="is-danger" disabled={!ok}>− Damage / pay</button>
            <button type="button" disabled={!ok} onClick={() => go({ type: "lp", player, delta: n })}>+ Gain</button>
            <button type="button" disabled={!ok} onClick={() => go({ type: "lp", player, set: n })}>Set to</button>
          </div>
        </form>
        <div className="duel-lp-actions">
          {quick.map((q) => <button key={q} onClick={() => go({ type: "lp", player, delta: -q })}>−{q}</button>)}
          <button onClick={() => go({ type: "lp", player, set: Math.ceil(lp / 2) })} disabled={lp <= 1}>Halve</button>
        </div>
      </div>
    </Modal>
  );
}

/** Chain prompts, one click away beside Next / End turn: when the duel stops to ask "chain a card?" (⚙ has the
 *  same setting). */
export function ChainModeSwitch({ mode, set }: { mode: AutoPassMode; set(m: AutoPassMode): void }) {
  const opts: [AutoPassMode, string, string][] = [
    ["ask", "Ask", "Always ask whenever you could chain"],
    ["smart", "Smart", "Only stop when your opponent does something (your monsters' effects always ask)"],
    ["never", "Mine", "Only stop for your monsters' effects (triggers, hand traps)"],
  ];
  return (
    <div className="duel-chainmode" role="radiogroup" aria-label="Chain prompts">
      <span className="duel-chainmode-label">Chains</span>
      {opts.map(([m, label, hint]) => (
        <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? "is-on" : ""} title={`${AUTO_PASS_LABEL[m]}: ${hint}`} onClick={() => set(m)}>{label}</button>
      ))}
    </div>
  );
}
