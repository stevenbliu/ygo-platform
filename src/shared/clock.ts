// The duel clock's arithmetic (DuelRoom keeps the state and calls this on every update / alarm).
// Only the player the duel waits on (the one with a decision) is charged. "turn": both clocks refill at
// every new turn. "chess": a bank for the whole duel, plus the increment back after each decision.
import type { RoomSettings } from "./roomSettings.ts";

export type ClockSeat = 0 | 1;
export interface ClockState {
  remaining: [number, number];
  running: ClockSeat | null;
  since: number;
  /** The board turn the clock last saw (to refill at a new turn). */
  turn: number;
  /** The decision being timed ("seat:prompt id"): when it changes, the player answered. */
  decision?: string | null;
  /** Nobody's clock runs before this time: the board is still showing what just happened (shared/pacing.ts). */
  graceUntil?: number;
}
export type ClockRules = Pick<RoomSettings, "timeControl" | "turnTimerSec" | "incrementSec">;

/** Advance the clock to `now`. Returns the seat that ran out of time (the clock stops), or null.
 *  `turn` = the board's turn number; `waitingOn` = who has to decide now; `decisionOf(seat)` = that
 *  seat's current decision key (null when they have none). */
export function stepClock(c: ClockState, rules: ClockRules, now: number, turn: number,
  waitingOn: ClockSeat | null, decisionOf: (seat: ClockSeat) => string | null): ClockSeat | null {
  // `since` can be in the future: the grace after an update (time spent watching it isn't charged)
  if (c.running !== null) c.remaining[c.running] = Math.max(0, c.remaining[c.running] - Math.max(0, now - c.since));
  c.since = Math.max(now, c.graceUntil ?? 0);
  if (c.running !== null && c.remaining[c.running] <= 0) {
    const out = c.running;
    c.running = null;
    return out;
  }
  const was = c.running;
  if (rules.timeControl === "chess" && was !== null && c.decision && c.decision !== decisionOf(was)) {
    c.remaining[was] += rules.incrementSec * 1000;
  }
  if (rules.timeControl === "turn" && turn !== c.turn) {
    c.turn = turn;
    c.remaining = [rules.turnTimerSec * 1000, rules.turnTimerSec * 1000];
  }
  c.running = waitingOn;
  c.decision = waitingOn === null ? null : decisionOf(waitingOn);
  return null;
}
