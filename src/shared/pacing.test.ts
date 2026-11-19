import { describe, expect, it } from "vitest";
import { BEAT_MS, MAX_PRESENTATION_MS, presentationMs } from "./pacing.ts";

describe("duel pacing", () => {
  it("gives each moment its beat", () => {
    expect(presentationMs([{ e: "chain" }])).toBe(BEAT_MS.activate);
    expect(presentationMs([{ e: "phase" }, { e: "phase", step: "damage" }])).toBe(BEAT_MS.phase);
    expect(presentationMs([{ e: "draw", codes: [1, 2, 3] }])).toBe(BEAT_MS.draw + 2 * BEAT_MS.drawEach);
    expect(presentationMs([{ e: "hint" }, { e: "move" }])).toBe(0);
  });
  it("caps a long combo", () => {
    expect(presentationMs(Array.from({ length: 30 }, () => ({ e: "summon" })))).toBe(MAX_PRESENTATION_MS);
  });
});
