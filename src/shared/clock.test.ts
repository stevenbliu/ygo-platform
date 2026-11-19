import { describe, expect, it } from "vitest";
import { stepClock, type ClockState } from "./clock.ts";
import { cleanSettings, formatTimeControl, parseTimeControl, timeControlValue } from "./roomSettings.ts";

const chess = { timeControl: "chess" as const, turnTimerSec: 0, incrementSec: 3 };
const turnRules = { timeControl: "turn" as const, turnTimerSec: 60, incrementSec: 0 };
const fresh = (ms: number): ClockState => ({ remaining: [ms, ms], running: null, since: 0, turn: 0, decision: null });

describe("duel clock", () => {
  it("charges only the player who has to decide", () => {
    const c = fresh(300_000);
    let decision: string | null = "0:1";
    stepClock(c, chess, 0, 1, 0, () => decision);          // seat 0 has prompt 1
    stepClock(c, chess, 10_000, 1, 0, () => decision);     // 10 s later, still deciding
    expect(c.remaining).toEqual([290_000, 300_000]);
    // seat 1 gets a chance to chain during seat 0's turn: seat 1's clock runs, not seat 0's
    decision = null;
    stepClock(c, chess, 12_000, 1, 1, (s) => (s === 1 ? "1:2" : null));
    stepClock(c, chess, 20_000, 1, 1, (s) => (s === 1 ? "1:2" : null));
    expect(c.remaining[1]).toBe(300_000 - 8_000);
  });

  it("chess: adds the increment to whoever answered", () => {
    const c = fresh(300_000);
    stepClock(c, chess, 0, 1, 0, () => "0:1");
    stepClock(c, chess, 5_000, 1, 0, () => "0:2");          // answered prompt 1, now prompt 2
    expect(c.remaining[0]).toBe(300_000 - 5_000 + 3_000);
    stepClock(c, chess, 6_000, 1, 1, (s) => (s === 1 ? "1:3" : null));   // answered prompt 2; seat 1's turn to decide
    expect(c.remaining[0]).toBe(300_000 - 6_000 + 6_000);
    expect(c.running).toBe(1);
  });

  it("chess: no refill at a new turn", () => {
    const c = fresh(100_000);
    stepClock(c, chess, 0, 1, 0, () => "0:1");
    stepClock(c, chess, 50_000, 2, null, () => null);
    expect(c.remaining[0]).toBe(100_000 - 50_000 + 3_000);
  });

  it("per turn: both clocks refill at every new turn", () => {
    const c = fresh(60_000);
    stepClock(c, turnRules, 0, 1, 1, () => "1:1");          // the non-turn player chains on turn 1
    stepClock(c, turnRules, 40_000, 1, 0, () => "0:2");
    expect(c.remaining[1]).toBe(20_000);
    stepClock(c, turnRules, 41_000, 2, 1, () => "1:3");     // turn 2: everyone back to 60 s
    expect(c.remaining).toEqual([60_000, 60_000]);
  });

  it("doesn't charge the grace time while an update plays out", () => {
    const c = fresh(300_000);
    stepClock(c, chess, 0, 1, 0, () => "0:1");
    c.graceUntil = 5_000;                                   // an activation is showing until t = 5 s
    stepClock(c, chess, 1_000, 1, 0, () => "0:1");
    expect(c.since).toBe(5_000);
    stepClock(c, chess, 4_000, 1, 0, () => "0:1");          // still showing: nothing charged
    expect(c.remaining[0]).toBe(299_000);                   // (the 1 s before the grace started)
    stepClock(c, chess, 8_000, 1, 0, () => "0:1");          // 3 s after it ended
    expect(c.remaining[0]).toBe(296_000);
  });
  it("reports who ran out", () => {
    const c = fresh(5_000);
    stepClock(c, chess, 0, 1, 1, () => "1:1");
    expect(stepClock(c, chess, 6_000, 1, 1, () => "1:1")).toBe(1);
    expect(c.running).toBeNull();
  });
});

describe("time control settings", () => {
  it("keeps old rooms' per-turn timers", () => {
    expect(cleanSettings({ turnTimerSec: 120 })).toMatchObject({ timeControl: "turn", turnTimerSec: 120 });
    expect(cleanSettings({})).toMatchObject({ timeControl: "off" });
  });
  it("allows custom times and LP within the limits", () => {
    expect(cleanSettings({ timeControl: "chess", bankSec: 300, incrementSec: 3 })).toMatchObject({ timeControl: "chess", bankSec: 300, incrementSec: 3 });
    expect(cleanSettings({ timeControl: "chess", bankSec: 450, incrementSec: 0 })).toMatchObject({ timeControl: "chess", bankSec: 450, incrementSec: 0 });
    expect(formatTimeControl(cleanSettings({ timeControl: "chess", bankSec: 450, incrementSec: 7 }))).toBe("7:30+7");
    expect(cleanSettings({ timeControl: "turn", turnTimerSec: 45 })).toMatchObject({ timeControl: "turn", turnTimerSec: 45 });
    expect(cleanSettings({ startingLP: 6000 }).startingLP).toBe(6000);
    for (const bad of [{ bankSec: 1, incrementSec: 3 }, { bankSec: 300, incrementSec: 999 }, { bankSec: 300.5, incrementSec: 3 }, { bankSec: "300", incrementSec: -1 }])
      expect(cleanSettings({ timeControl: "chess", ...bad }).timeControl).toBe("off");
    expect(cleanSettings({ timeControl: "turn", turnTimerSec: 5 }).timeControl).toBe("off");
    expect(cleanSettings({ startingLP: 50 }).startingLP).toBe(8000);
    expect(cleanSettings({ startingLP: 1e9 }).startingLP).toBe(8000);
  });
  it("round-trips the select value and formats it", () => {
    const s = cleanSettings({ ...parseTimeControl("chess:600+5") });
    expect(timeControlValue(s)).toBe("chess:600+5");
    expect(formatTimeControl(s)).toBe("10+5");
    expect(formatTimeControl(cleanSettings(parseTimeControl("turn:180")))).toBe("3 min per turn");
  });
});
