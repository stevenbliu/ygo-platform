import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { toCss } from "./uiScale.ts";
import type { MenuItem } from "./menus.ts";
import type { Toast } from "./useDuel.ts";
import { CardView } from "./CardView.tsx";
import { getCard } from "./useDuel.ts";

/** Popup menu at (x, y); a bottom sheet on narrow screens. Items with `sub` open a nested list. */
export function ContextMenu({ x, y, title, items, onClose }: { x: number; y: number; title?: string; items: MenuItem[]; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [stack, setStack] = useState<{ title?: string; items: MenuItem[] }[]>([{ title, items }]);
  const [pos, setPos] = useState({ left: x, top: y });
  const cur = stack[stack.length - 1];

  useEffect(() => { setStack([{ title, items }]); }, [items, title]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // screen px, then into the (possibly scaled) page's CSS px
    setPos({ left: toCss(Math.max(8, Math.min(x, innerWidth - r.width - 8))), top: toCss(Math.max(8, Math.min(y, innerHeight - r.height - 8))) });
  }, [x, y, cur]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); return; }
      // arrows move between items, 1-9 pick one
      const btns = [...(ref.current?.querySelectorAll<HTMLButtonElement>(".duel-menu-item") ?? [])];
      const i = btns.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault(); e.stopImmediatePropagation();
        btns[(i + (e.key === "ArrowDown" ? 1 : btns.length - 1)) % btns.length]?.focus();
      } else if (/^[1-9]$/.test(e.key)) {
        const b = btns[Number(e.key) - 1];
        if (b && !b.classList.contains("duel-menu-close")) { e.preventDefault(); e.stopImmediatePropagation(); b.click(); }
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);
  useEffect(() => { ref.current?.querySelector<HTMLButtonElement>("button")?.focus(); }, [cur]);

  return (
    <div className="duel-menu-backdrop" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <div className="duel-menu" ref={ref} style={{ left: pos.left, top: pos.top }} onClick={(e) => e.stopPropagation()} role="menu">
        {(cur.title || stack.length > 1) && (
          <div className="duel-menu-title">
            {stack.length > 1 && <button className="duel-menu-back" onClick={() => setStack((s) => s.slice(0, -1))} aria-label="Back">‹</button>}
            <span>{cur.title}</span>
          </div>
        )}
        {cur.items.length === 0 && <div className="duel-menu-empty muted">Nothing to do here.</div>}
        {cur.items.map((it, i) => (
          <button
            key={i}
            role="menuitem"
            className={`duel-menu-item ${it.danger ? "is-danger" : ""}`}
            onClick={() => {
              if (it.sub) setStack((s) => [...s, { title: it.label, items: it.sub! }]);
              else { onClose(); it.run?.(); }
            }}
          >
            <span>{it.label}</span>
            {it.sub ? <span className="muted">›</span> : it.key ? <kbd>{it.key}</kbd> : i < 9 ? <kbd className="duel-menu-num">{i + 1}</kbd> : null}
          </button>
        ))}
        {/* an obvious way out */}
        <button className="duel-menu-item duel-menu-close" onClick={() => (stack.length > 1 ? setStack((s) => s.slice(0, -1)) : onClose())}>
          <span>{stack.length > 1 ? "‹ Back" : "✕ Close"}</span><kbd>Esc</kbd>
        </button>
      </div>
    </div>
  );
}

/** A dialog. `docked`: no dimmed backdrop and the board stays live around it (card pickers and pile views:
 *  you can still see, hover and preview the board while choosing); Esc or its ✕ closes it. */
export function Modal({ title, onClose, children, wide, docked }: { title: ReactNode; onClose(): void; children: ReactNode; wide?: boolean; docked?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className={`duel-modal-backdrop ${docked ? "is-docked" : ""}`} onClick={docked ? undefined : onClose}>
      <div className={`duel-modal ${wide ? "is-wide" : ""}`} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal={!docked}>
        <div className="duel-modal-head">
          <h2>{title}</h2>
          <button onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="duel-modal-body">{children}</div>
      </div>
    </div>
  );
}

export function Toasts({ toasts, names, describe }: { toasts: Toast[]; names: [string, string]; describe(uid: string): string }) {
  return (
    <div className="duel-toasts" aria-live="polite">
      {toasts.map((t) => {
        if (t.text) return <div key={t.id} className={`duel-toast ${t.error ? "is-error" : ""}`}>{t.text}</div>;
        const ev = t.event!;
        const who = names[ev.player];
        switch (ev.kind) {
          case "dice": return <div key={t.id} className="duel-toast">{who} rolled a die: <b>{ev.value}</b></div>;
          case "coin": return <div key={t.id} className="duel-toast">{who} flipped a coin: <b>{ev.heads ? "Heads" : "Tails"}</b></div>;
          case "attack": return <div key={t.id} className="duel-toast is-attack">{who}: {describe(ev.attacker)} attacks {ev.target ? describe(ev.target) : "directly"}</div>;
          case "reveal": return (
            <div key={t.id} className="duel-toast is-reveal">
              <div>{who} reveals:</div>
              <div className="duel-reveal-row">
                {ev.cards.map((c) => <div key={c.uid} title={getCard(c.code)?.name}><CardView card={{ ...c, faceUp: true }} /></div>)}
              </div>
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}
