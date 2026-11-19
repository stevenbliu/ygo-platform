// Keyboard-only play: a cursor over whatever is highlighted on the board (arrow keys), Enter to click it,
// number keys for its action buttons / the chain options, and a cheat sheet (⌨ in the top line, or K).
import { useEffect, useRef, useState } from "react";

/** Everything the cursor can land on: cards and zones the duel highlights right now. */
const TARGETS = [
  ".duel-board-wrap .duel-card.is-actionable", ".duel-board-wrap .duel-card.is-selectable", ".duel-board-wrap .duel-card.is-picked",
  ".duel-board-wrap .duel-zone.is-place", ".duel-board-wrap .duel-zone.is-pick", ".duel-modal .duel-card.is-selectable", ".duel-modal .duel-card.is-picked",
].join(", ");

const center = (el: Element) => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };

/** The next target from `from` in a direction (nearest by distance, with a strong preference for the axis). */
function nextTarget(list: HTMLElement[], from: HTMLElement | null, dir: "left" | "right" | "up" | "down"): HTMLElement | null {
  if (!list.length) return null;
  if (!from || !list.includes(from)) {
    // start from the bottom-left (your hand / your side)
    return [...list].sort((a, b) => center(b).y - center(a).y || center(a).x - center(b).x)[0];
  }
  const o = center(from);
  let best: HTMLElement | null = null, bestScore = Infinity;
  for (const el of list) {
    if (el === from) continue;
    const c = center(el), dx = c.x - o.x, dy = c.y - o.y;
    const along = dir === "left" ? -dx : dir === "right" ? dx : dir === "up" ? -dy : dy;
    const across = dir === "left" || dir === "right" ? Math.abs(dy) : Math.abs(dx);
    if (along <= 4) continue;
    const score = along + across * 2.5;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  // wrap around on the same axis
  if (!best && (dir === "left" || dir === "right")) {
    const row = list.filter((el) => Math.abs(center(el).y - o.y) < 40).sort((a, b) => center(a).x - center(b).x);
    best = dir === "right" ? row[0] : row[row.length - 1];
  }
  return best ?? null;
}

function hover(el: HTMLElement | null, on: boolean) {
  if (!el) return;
  const card = el.matches(".duel-card") ? el : el.querySelector<HTMLElement>(".duel-card");
  card?.dispatchEvent(new MouseEvent(on ? "mouseover" : "mouseout", { bubbles: true, relatedTarget: null }));
}

/** Installs the keyboard cursor. Handled keys stop here (capture phase) so other handlers don't also act. */
export function useKeyboardCursor(enabled: boolean) {
  const cur = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const setCur = (el: HTMLElement | null) => {
      if (cur.current === el) return;
      cur.current?.classList.remove("is-kbd-cursor");
      hover(cur.current, false);
      cur.current = el;
      if (el) {
        el.classList.add("is-kbd-cursor");
        el.scrollIntoView?.({ block: "nearest", inline: "nearest" });
        hover(el, true);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.ctrlKey || e.metaKey || e.altKey || t.closest?.("input, textarea, select")) return;
      if (document.querySelector(".duel-menu")) return;   // the menu has its own keys
      const list = [...document.querySelectorAll<HTMLElement>(TARGETS)].filter((el) => el.getClientRects().length);
      if (cur.current && !list.includes(cur.current)) setCur(null);
      const dirs: Record<string, "left" | "right" | "up" | "down"> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };
      const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };
      if (dirs[e.key]) {
        const n = nextTarget(list, cur.current, dirs[e.key]);
        if (n) { setCur(n); stop(); }
        return;
      }
      if (e.key === "Enter" && cur.current && !t.closest("button")) {
        const el = cur.current;
        const r = el.getBoundingClientRect();
        // a click at the card's centre (menus open there)
        el.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }));
        stop();
        return;
      }
      if (/^[1-9]$/.test(e.key)) {
        const i = Number(e.key) - 1;
        // the cursor card's action buttons first, then the chain options in the dock
        const quick = cur.current?.querySelectorAll<HTMLButtonElement>(".duel-quick button");
        const chain = document.querySelectorAll<HTMLButtonElement>(".duel-chain-options button");
        const btn = quick?.length ? quick[i] : chain[i];
        if (btn) { btn.click(); stop(); }
        return;
      }
      if (e.key === "Escape" && cur.current) setCur(null);
    };
    addEventListener("keydown", onKey, true);
    return () => { removeEventListener("keydown", onKey, true); setCur(null); };
  }, [enabled]);
}

const GROUPS: { title: string; keys: [string, string][] }[] = [
  { title: "Move around", keys: [["← → ↑ ↓", "Move the cursor over cards you can use / pick"], ["Enter", "Click the card under the cursor (actions, pick)"], ["1–4", "That card's action buttons"], ["Z", "Zoom the card"]] },
  { title: "Decisions", keys: [["1–9", "Chain the 1st, 2nd… option in the dock"], ["Enter", "Confirm a selection"], ["Esc", "Cancel / don't chain / close"], ["Space", "Pass on a chain (or end your turn); while a summon, effect or phase plays out: skip to the decision"], ["M", "View the board / back to the decision"]] },
  { title: "Turn", keys: [["N", "Next phase"], ["B", "Battle Phase"], ["E", "End turn"]] },
  { title: "Other", keys: [["L", "Duel log and chat"], ["K", "This sheet"], ["?", "How to play"]] },
];

export function ShortcutSheet() {
  return (
    <div className="duel-shortcuts-grid">
      {GROUPS.map((g) => (
        <section key={g.title}>
          <h4>{g.title}</h4>
          <dl>{g.keys.map(([k, v]) => <div key={k + v}><dt><kbd>{k}</kbd></dt><dd>{v}</dd></div>)}</dl>
        </section>
      ))}
    </div>
  );
}

/** ⌨ in the top line: the cheat sheet in a pop-over (K toggles it). */
export function ShortcutsButton() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.ctrlKey || e.metaKey || e.altKey || t.closest?.("input, textarea, select")) return;
      if (e.key === "k" || e.key === "K") { setOpen((o) => !o); e.preventDefault(); }
      else if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    addEventListener("keydown", onKey);
    addEventListener("mousedown", onDown);
    return () => { removeEventListener("keydown", onKey); removeEventListener("mousedown", onDown); };
  }, []);
  return (
    <div className="duel-settings" ref={ref}>
      <button className={`duel-help-btn ${open ? "is-on" : ""}`} onClick={() => setOpen((o) => !o)} aria-expanded={open} title="Keyboard shortcuts (K)" aria-label="Keyboard shortcuts">⌨</button>
      {open && <div className="duel-settings-panel duel-shortcuts-panel" role="dialog" aria-label="Keyboard shortcuts"><h3>Keyboard shortcuts</h3><ShortcutSheet /></div>}
    </div>
  );
}
