// Duel clocks. The server keeps time (and decides time-outs); these tick locally between its updates.
//  - TurnTimer: the small m:ss next to a player's name
//  - SecondBar: the bar under a player's LP, draining from full to empty every second while their clock runs
//  - ClockFace: the big clock beside the turn sign: whoever is deciding, a ring sweeping each second,
//    an arc for the time left, a flip when the clock passes to the other player, "+3s" on an increment
import { usePageFlag } from "./pageFlag.ts";
import { useEffect, useMemo, useRef, useState } from "react";
import type { TurnClock } from "../../../shared/duel.ts";
import { play as sfx } from "./anim/sfx.ts";

const fmt = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** A seat's time left right now (ms), whether its clock runs, how far into the current second it is, and
 *  `secDelay`: a negative CSS animation-delay that keeps a 1s-per-cycle CSS animation in step with this
 *  clock's seconds (so the smooth sweeps run on the compositor, with no re-render per frame). */
export function useClockLeft(timer: TurnClock, seat: 0 | 1, smooth = false) {
  const receivedAt = useMemo(() => Date.now(), [timer]);
  const ticking = timer.running === seat;
  void smooth;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, [ticking]);
  // `since` ahead of the server's clock: the board is still playing out an update (shared/pacing.ts), the
  // clock waits; it shows as paused until then
  const elapsed = timer.serverNow - timer.since + (Date.now() - receivedAt);
  const running = ticking && elapsed >= 0;
  const left = Math.max(0, timer.remaining[seat] - (running ? elapsed : 0));
  /** 1 at the start of a second, 0 at its end */
  const secondFrac = running ? (left % 1000) / 1000 : 1;
  // fixed per server update: the clock's phase within a second when it arrived
  const secDelay = useMemo(() => {
    const at = Math.max(0, timer.remaining[seat] - (ticking ? Math.max(0, timer.serverNow - timer.since) : 0));
    return `${-((1000 - (at % 1000)) % 1000) / 1000 - (Date.now() - receivedAt) / 1000}s`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timer, seat, ticking]);
  return { left, running, secondFrac, secDelay };
}

const urgency = (left: number) => (left <= 10_000 ? "is-critical" : left <= 30_000 ? "is-low" : "");

/** One player's clock, small (next to their name). */
/** "+3s" when a seat's bank gets the chess increment. The server charges the time spent first and then
 *  adds the increment, so the bonus is what was added beyond the time charged:
 *  new remaining - (old remaining - time the clock ran in between). */
export function useIncrementPop(timer: TurnClock, seat: 0 | 1) {
  const prev = useRef(timer);
  const [bonus, setBonus] = useState<{ key: number; sec: number } | null>(null);
  useEffect(() => {
    const p = prev.current;
    prev.current = timer;
    if (timer.mode !== "chess" || !timer.incrementSec || p === timer) return;
    const charged = p.running === seat ? Math.max(0, timer.since - p.since) : 0;
    const gain = timer.remaining[seat] - (p.remaining[seat] - charged);
    if (gain >= 900) setBonus({ key: Date.now(), sec: Math.round(gain / 1000) });
  }, [timer, seat]);
  useEffect(() => { if (!bonus) return; const t = setTimeout(() => setBonus(null), 1400); return () => clearTimeout(t); }, [bonus]);
  return bonus;
}

export function TurnTimer({ timer, seat, label }: { timer: TurnClock; seat: 0 | 1; label?: string }) {
  const { left, running } = useClockLeft(timer, seat);
  const bonus = useIncrementPop(timer, seat);
  return (
    <span className={`turn-timer${running ? " is-running" : ""} ${urgency(left)}`}
      title={timer.mode === "chess"
        ? `${label ?? "Time"} left in the duel (${timer.limitSec / 60} min, +${timer.incrementSec}s after each decision). The clock only runs while you're deciding.`
        : `${label ?? "Time"} left this turn (${timer.limitSec / 60} min per turn). The clock only runs while you're deciding.`}
      role="timer" aria-live={running && left <= 30_000 ? "polite" : "off"}>
      <span aria-hidden="true">⏱</span> {fmt(left)}{timer.mode === "chess" && timer.incrementSec ? <small className="turn-timer-inc">+{timer.incrementSec}</small> : null}
      {bonus && <span key={bonus.key} className="duel-clock-bonus is-small">+{bonus.sec}s</span>}
    </span>
  );
}

/** The bar under a player's LP: drains from full to empty every second while their clock runs. */
export function SecondBar({ timer, seat }: { timer: TurnClock; seat: 0 | 1 }) {
  const { left, running, secondFrac } = useClockLeft(timer, seat, true);
  return (
    <span className={`duel-secbar ${running ? "is-running" : ""} ${urgency(left)}`} aria-hidden="true">
      <i style={{ transform: `scaleX(${running ? secondFrac : 1})` }} />
    </span>
  );
}

/** The big clock beside the turn sign: the time of whoever the duel is waiting on. */
export function ClockFace({ timer, seat, label, mine }: { timer: TurnClock; seat: 0 | 1; label: string; mine: boolean }) {
  usePageFlag("clock");
  const { left, running, secDelay } = useClockLeft(timer, seat, true);
  const bonus = useIncrementPop(timer, seat);
  // a soft tick each second in your last ten
  const lastSec = useRef(-1);
  const sec = Math.ceil(left / 1000);
  useEffect(() => {
    if (!mine || !running || sec > 10 || sec <= 0 || sec === lastSec.current) return;
    lastSec.current = sec;
    sfx("pick");
  }, [sec, mine, running]);

  const total = Math.max(1, timer.limitSec * 1000);
  const bank = Math.min(1, left / total);
  return (
    <div key={seat} className={`duel-clockface ${mine ? "is-mine" : "is-theirs"} ${running ? "is-running" : "is-paused"} ${urgency(left)}`}
      role="timer" aria-label={`${label}: ${fmt(left)}`} style={{ ["--sec-delay" as string]: secDelay, ["--bank" as string]: bank }}>
      <span className="duel-clock-dial" aria-hidden="true">
        <span className="duel-clock-bank" />
        {/* re-mounted on each server update: its 1s animation restarts in step (--sec-delay) */}
        <span key={`${timer.since}-${timer.serverNow}`} className="duel-clock-sweep" />
        <b className="duel-clock-digits">{fmt(left)}</b>
      </span>
      <small className="duel-clock-label">{label}</small>
      {bonus && <span key={bonus.key} className="duel-clock-bonus">+{bonus.sec}s</span>}
    </div>
  );
}

/** Text that is its own seconds bar: the bright fill drains across the letters every second while the
 *  clock runs (the turn sign uses it). */
export function SecondsText({ timer, seat, children }: { timer: TurnClock; seat: 0 | 1; children: string }) {
  const { left, running, secDelay } = useClockLeft(timer, seat, true);
  return (
    <b key={`${timer.since}-${timer.serverNow}`} className={`duel-sectext ${running ? "is-running" : ""} ${urgency(left)}`} style={{ ["--sec-delay" as string]: secDelay }} data-text={children}>
      {children}
    </b>
  );
}
