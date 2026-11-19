// Duel pacing: how long each kind of moment holds the stage before the next one plays, and before anyone is
// asked to decide. The client waits these beats (and for the animations themselves) before it shows the next
// update or prompt (useDuel.ts + animator.settle); the server doesn't charge anyone's clock for the same time
// (presentationMs -> ClockState.graceUntil), so watching an effect never costs you time.

export const BEAT_MS = {
  /** a summon (its card-art splash, then its effect) */
  summon: 1500,
  /** a Set card landing */
  set: 450,
  /** a card or effect activating (a chain link: its splash, then its effect) */
  activate: 1400,
  /** a chain link resolving */
  resolve: 650,
  /** a new phase: the banner reads (it shows 1.35 s; the next moment starts as it fades) */
  phase: 1000,
  /** a new turn: the turn banner (shows 1.7 s) */
  turn: 1500,
  /** an attack declared */
  attack: 900,
  /** the first card drawn, and each one after it */
  draw: 650,
  drawEach: 220,
  /** life points changing */
  lp: 600,
  /** cards shown to a player */
  confirm: 700,
} as const;

/** The most one update may hold the clock for (a long combo in one update still costs some time). */
export const MAX_PRESENTATION_MS = 8000;

/** Minimal shape of an engine event (shared/enginePrompts.ts EngineEvent) this needs. */
type Ev = { e: string; how?: string; step?: string; phase?: string; codes?: number[]; cause?: string; delta?: number };

/** How long the client will spend showing these events: the server's estimate for the clock's grace time. */
export function presentationMs(events: readonly Ev[] | null | undefined): number {
  if (!events?.length) return 0;
  let ms = 0;
  for (const ev of events) {
    switch (ev.e) {
      case "turn": ms += BEAT_MS.turn; break;
      // (the Draw / Standby Phase get no banner)
      case "phase": if ((!ev.step || ev.step === "start") && ev.phase !== "draw" && ev.phase !== "standby") ms += BEAT_MS.phase; break;
      case "summon": ms += BEAT_MS.summon; break;
      case "set": ms += BEAT_MS.set; break;
      case "chain": ms += BEAT_MS.activate; break;
      case "chainSolved": ms += BEAT_MS.resolve; break;
      case "attack": ms += BEAT_MS.attack; break;
      case "draw": ms += BEAT_MS.draw + Math.max(0, (ev.codes?.length ?? 1) - 1) * BEAT_MS.drawEach; break;
      case "lp": if (ev.delta) ms += BEAT_MS.lp; break;
      case "confirm": ms += BEAT_MS.confirm; break;
    }
  }
  return Math.min(MAX_PRESENTATION_MS, ms);
}
