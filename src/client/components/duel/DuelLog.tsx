// The duel log on the board (desktop rail): every line of the duel, scrollable, styled by what it says
// (turn banners, phase markers, chain links, summons, LP changes, each player's actions in their colour).
// It is the only log; the chat is separate (toolbar "Chat").
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Seat } from "../../../shared/duelActions.ts";
import { LogText } from "./SidePanel.tsx";
import { toCss, uiZoom } from "./uiScale.ts";
import "./duel-log.css";

export type LogKind = "turn" | "phase" | "chain" | "negate" | "summon" | "set" | "draw" | "lp-loss" | "lp-gain" | "attack" | "gy" | "banish" | "coin" | "win" | "other";
export interface LogInfo { kind: LogKind; actor: Seat | null; turn?: number }

const PHASE_RE = /^(Draw|Standby|Main|Battle|End) Phase( \d)?$/;

/** What a log line is about, and whose action it is (when it starts with a player's name). */
export function classifyLog(line: string, names: [string, string]): LogInfo {
  const t = /^Turn (\d+): (.*)$/.exec(line);
  if (t) return { kind: "turn", actor: t[2] === names[0] ? 0 : t[2] === names[1] ? 1 : null, turn: Number(t[1]) };
  if (PHASE_RE.test(line)) return { kind: "phase", actor: null };
  if (/^Chain \d+ negated/.test(line)) return { kind: "negate", actor: null };
  if (/^Chain \d+:/.test(line)) return { kind: "chain", actor: null };
  // longest name first, so "Ann" doesn't claim a line by "Anna"
  const order: Seat[] = names[0].length >= names[1].length ? [0, 1] : [1, 0];
  const actor = order.find((s) => names[s] && (line.startsWith(`${names[s]} `) || line.startsWith(`${names[s]}'s `))) ?? null;
  const rest = actor === null ? line : line.slice(names[actor].length);
  const kind: LogKind = / wins the duel|is a draw/.test(line) ? "win"
    : /^ (Normal|Special|Flip) Summoned /.test(rest) ? "summon"
    : /^ Set /.test(rest) ? "set"
    : /^ drew /.test(rest) ? "draw"
    : /^ lost \d+ LP/.test(rest) ? "lp-loss"
    : /^ gained \d+ LP/.test(rest) ? "lp-gain"
    : / attacks /.test(rest) ? "attack"
    : / was sent to the GY$/.test(line) ? "gy"
    : / was banished$/.test(line) ? "banish"
    : /^ (tossed a coin|rolled) /.test(rest) ? "coin"
    : "other";
  return { kind, actor };
}

/** The line's text with its key words emphasised (verbs, numbers, chain links). */
function Line({ text, info, names, onHover, onZoom }: { text: string; info: LogInfo; names: [string, string]; onHover(code: number | null): void; onZoom(code: number): void }) {
  if (info.kind === "turn") {
    return <span className="dl-turn-text"><b>Turn {info.turn}</b><span>{info.actor !== null ? names[info.actor] : text.replace(/^Turn \d+: /, "")}</span><i aria-hidden="true" /></span>;
  }
  if (info.kind === "phase") return <span className="dl-phase-text">{text}</span>;
  const m = /^(Chain \d+)(:| negated)(.*)$/.exec(text);
  if (m) return <><b className="dl-link">{m[1]}</b>{m[2] === ":" ? " " : <i> negated</i>}<LogText text={m[3].replace(/^ /, "")} onHover={onHover} onZoom={onZoom} /></>;
  const who = info.actor !== null ? names[info.actor] : null;
  const body = who ? text.slice(who.length) : text;
  // verb / amount in bold, the rest plain
  const v = /^('s)?( ?)(Normal Summoned|Special Summoned|Flip Summoned|Set|drew \d+ cards?|lost \d+ LP|gained \d+ LP|tossed a coin|rolled)(.*)$/.exec(body);
  return (
    <>
      {who && <b className="dl-who">{who}</b>}
      {v ? <>{v[1]}{v[2]}<b className="dl-verb">{v[3]}</b><LogText text={v[4]} onHover={onHover} onZoom={onZoom} /></> : <LogText text={body} onHover={onHover} onZoom={onZoom} />}
    </>
  );
}

export function DuelLog({ log, names, you, onHover, onZoom }: {
  log: string[]; names: [string, string]; you: Seat | null; onHover(code: number | null): void; onZoom(code: number): void;
}) {
  const [folded, setFoldedState] = useState(() => { try { return localStorage.getItem("ygo.logFolded") === "1"; } catch { return false; } });
  const setFolded = (v: boolean) => { setFoldedState(v); try { localStorage.setItem("ygo.logFolded", v ? "1" : "0"); } catch { /* storage blocked */ } };
  const [tall, setTall] = useState(false);
  const listRef = useRef<HTMLOListElement>(null);
  const atBottom = useRef(true);
  const [missed, setMissed] = useState(0);
  // lines added since the last render are "new" (they flash in)
  const seen = useRef(log.length);
  const firstNew = seen.current;
  useEffect(() => { seen.current = log.length; });

  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (atBottom.current) {
      // stick to the bottom on the next frame: reading scrollHeight here, mid-render, forced a layout of the
      // whole duel page on every new log line (a stutter while effects animate)
      const f = requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
      setMissed(0);
      return () => cancelAnimationFrame(f);
    }
    setMissed((n) => n + Math.max(0, log.length - firstNew));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [log.length, folded, tall]);
  const onScroll = () => {
    const el = listRef.current!;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    if (atBottom.current) setMissed(0);
  };
  const toBottom = () => { const el = listRef.current; if (el) { el.scrollTop = el.scrollHeight; atBottom.current = true; setMissed(0); } };

  if (!log.length) return null;
  return (
    <div className={`dl ${folded ? "is-folded" : ""} ${tall ? "is-tall" : ""}`} role="log" aria-label="Duel log">
      <div className="dl-head">
        <button className="dl-title" onClick={() => setFolded(!folded)} aria-expanded={!folded} title={folded ? "Show the duel log" : "Fold the duel log away"}>
          {folded ? "▸" : "▾"} Duel log
        </button>
        {!folded && <button className="dl-size" onClick={() => setTall(!tall)} title={tall ? "Smaller" : "Taller"} aria-label={tall ? "Make the log smaller" : "Make the log taller"}>{tall ? "▴" : "▾▾"}</button>}
      </div>
      {!folded && (
        <div className="dl-body">
          <ol className="dl-list" ref={listRef} onScroll={onScroll}>
            {log.map((l, i) => {
              const info = classifyLog(l, names);
              const side = info.actor === null ? "" : info.actor === you ? "is-you" : "is-opp";
              return (
                <li key={i} className={`dl-line k-${info.kind} ${side} ${i >= firstNew && i > 0 ? "is-new" : ""} ${i === log.length - 1 ? "is-last" : ""}`}>
                  <span className="dl-text"><Line text={l} info={info} names={names} onHover={onHover} onZoom={onZoom} /></span>
                </li>
              );
            })}
          </ol>
          {missed > 0 && <button className="dl-missed" onClick={toBottom}>↓ {missed} new</button>}
        </div>
      )}
    </div>
  );
}

/** Size the rail (log) to reach almost to the field: measure the board zones beside it. */
export function useRailFit(deps: unknown[]) {
  useEffect(() => {
    const fit = () => {
      const wrap = document.querySelector<HTMLElement>(".duel-page.is-live .duel-board-wrap");
      const rail = wrap?.querySelector<HTMLElement>(":scope > .duel-rail");
      if (!wrap || !rail || (innerWidth <= 1000 && uiZoom() === 1)) { wrap?.style.removeProperty("--rail-w"); return; }
      const r = rail.getBoundingClientRect();
      const top = r.top, bottom = Math.max(r.bottom, r.top + 200);
      let left = Infinity;
      for (const z of wrap.querySelectorAll<HTMLElement>(".duel-zone, .duel-pile")) {
        const b = z.getBoundingClientRect();
        if (b.width && b.bottom > top && b.top < bottom) left = Math.min(left, b.left);
      }
      if (!Number.isFinite(left)) return;
      const w = Math.round(toCss(left - r.left) - 14);   // screen px -> the page's CSS px
      wrap.style.setProperty("--rail-w", `${Math.max(180, Math.min(w, 520))}px`);
    };
    fit();
    const ro = new ResizeObserver(fit);
    const wrap = document.querySelector(".duel-board-wrap");
    if (wrap) ro.observe(wrap);
    addEventListener("resize", fit);
    const t = setTimeout(fit, 400);
    return () => { ro.disconnect(); removeEventListener("resize", fit); clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
