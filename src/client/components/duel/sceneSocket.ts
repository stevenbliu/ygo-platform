// Scene fixtures: the duel page at a fixed moment, with no server and no rules engine. Opening /duel/scene-<name>
// swaps the room's WebSocket for this stand-in, which replays public/scenes/<name>.json (a recorded room / session /
// board / prompt; scripts/ux/record-scenes.mjs). The page renders exactly as in a real duel at that moment; answers
// go nowhere. Used by the UX checks and screenshot baselines (npm run scenes).
export const SCENE_PREFIX = "scene-";
export const isScene = (roomId: string) => roomId.startsWith(SCENE_PREFIX);

export interface SceneFixture {
  name: string;
  /** What the scene shows (for the report). */
  about: string;
  /** Server messages, in order (room, session, state, prompt...). */
  msgs: unknown[];
}

/** Just enough of WebSocket for useDuelSocket. */
export class SceneSocket {
  readyState = 1;   // OPEN
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  constructor(name: string) {
    setTimeout(async () => {
      this.onopen?.();
      try {
        const res = await fetch(`/scenes/${encodeURIComponent(name)}.json`);
        if (!res.ok) throw new Error(`no scene "${name}" (${res.status})`);
        const fx = (await res.json()) as SceneFixture;
        for (const m of fx.msgs) this.onmessage?.({ data: JSON.stringify(m) });
        document.documentElement.dataset.scene = "ready";
      } catch (err) {
        console.error("scene", err);
        document.documentElement.dataset.scene = "error";
      }
    }, 0);
  }
  send() { /* a scene doesn't answer */ }
  close() { this.readyState = 3; }
}
