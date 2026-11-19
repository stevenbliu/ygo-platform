import { useEffect, useRef, useState, type FormEvent } from "react";
import { cardImage } from "../../api.ts";
import type { ChatLine } from "./useDuel.ts";
import { getCard } from "./useDuel.ts";
import { CardText } from "../cards/CardText.tsx";
import { RarityFoil, useRarity } from "../cards/Rarity.tsx";

/** Big card preview with its text. */
export function CardPreview({ code, onZoom, large }: { code: number | null; onZoom?: (code: number) => void; large?: boolean }) {
  const card = code ? getCard(code) : null;
  const rarity = useRarity()(code && code > 0 ? code : 0, undefined);
  if (!code || code <= 0) return <div className="duel-preview is-empty muted">Hover a card (long-press on touch) to read it here.</div>;
  const stats = card && card.category === "Monster"
    ? [card.attribute, card.race, card.linkval ? `LINK-${card.linkval}` : card.level ? `${/XYZ/i.test(card.type ?? "") ? "Rank" : "Level"} ${card.level}` : null, card.scale != null ? `Scale ${card.scale}` : null].filter(Boolean).join(" · ")
    : card ? [card.race, card.category].filter(Boolean).join(" ") : "";
  return (
    <div className={`duel-preview ${large ? "is-large" : ""}`}>
      {/* the card's foil, big (it follows the mouse here too) */}
      {onZoom
        ? <button className="duel-preview-zoom" onClick={() => onZoom(code)} title="Zoom" aria-label={`Zoom ${card?.name ?? "card"}`}>
            <span className="duel-preview-art" data-foil={rarity !== "common" ? rarity : undefined}><img src={cardImage(code, "full")} alt={card?.name ?? ""} /><RarityFoil rarity={rarity} type={card?.type} code={code} /></span>
          </button>
        : <span className="duel-preview-art" data-foil={rarity !== "common" ? rarity : undefined}><img src={cardImage(code, "full")} alt={card?.name ?? ""} /><RarityFoil rarity={rarity} type={card?.type} code={code} /></span>}
      <div className="duel-preview-text">
        {/* name and ATK / DEF share one row (less height, more room for the text) */}
        <div className="duel-preview-head">
          <h3>{card?.name ?? `Card ${code}`}</h3>
          {card && card.category === "Monster" && (
            <span className="duel-preview-atk">
              <b>{card.atk ?? "?"}</b>{card.linkval ? <small> ATK</small> : <><small>/</small><b>{card.defense ?? "?"}</b></>}
            </span>
          )}
        </div>
        {card && <div className="muted">{card.type}{stats ? ` — ${stats}` : ""}</div>}
        {card?.desc && <CardText text={card.desc} />}
      </div>
    </div>
  );
}

const LOG_HOVER_MS = 1000;
let logHoverTimer: ReturnType<typeof setTimeout> | undefined;

/** Renders a log line, turning [[code]] tokens into card names: rest on one to preview, click to zoom. */
export function LogText({ text, onHover, onZoom }: { text: string; onHover(code: number | null): void; onZoom?(code: number): void }) {
  const parts = text.split(/(\[\[\d+\]\])/g);
  // reading down the log shouldn't flash a card for every name you pass: preview after resting on one
  // for a moment (or right away on click)
  const enter = (code: number) => { clearTimeout(logHoverTimer); logHoverTimer = setTimeout(() => onHover(code), LOG_HOVER_MS); };
  const leave = () => { clearTimeout(logHoverTimer); onHover(null); };
  return (
    <>
      {parts.map((p, i) => {
        const m = /^\[\[(\d+)\]\]$/.exec(p);
        if (!m) return <span key={i}>{p}</span>;
        const code = Number(m[1]);
        return <b key={i} className="duel-log-card" role="button" tabIndex={0} title="Rest the mouse here to preview, click to zoom"
          onMouseEnter={() => enter(code)} onMouseLeave={leave}
          onClick={() => { clearTimeout(logHoverTimer); if (onZoom) onZoom(code); else onHover(code); }}>{getCard(code)?.name ?? `#${code}`}</b>;
      })}
    </>
  );
}

export function LogChat({ log, chat, canChat, onChat, onHover, initialTab = "log", only }: { log: string[]; chat: ChatLine[]; canChat: boolean; onChat(text: string): void; onHover(code: number | null): void; initialTab?: "log" | "chat"; /** just the chat, no tabs */ only?: "chat" }) {
  const [tabState, setTab] = useState<"log" | "chat">(initialTab);
  const tab = only ?? tabState;
  const [text, setText] = useState("");
  const [unread, setUnread] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const lastChat = useRef(chat.length);

  useEffect(() => {
    if (tab !== "chat" && chat.length > lastChat.current && !chat[chat.length - 1]?.system) setUnread((u) => u + 1);
    lastChat.current = chat.length;
  }, [chat, tab]);
  useEffect(() => { if (tab === "chat") setUnread(0); }, [tab]);
  useEffect(() => {
    const el = listRef.current;
    // (next frame, and not at all while the panel is hidden: the live duel shows its own log)
    if (!el) return;
    const f = requestAnimationFrame(() => { if (el.getClientRects().length) el.scrollTop = el.scrollHeight; });
    return () => cancelAnimationFrame(f);
  }, [log.length, chat.length, tab]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    onChat(text);
    setText("");
  };

  return (
    <div className="duel-logchat">
      {only ? <div className="duel-chat-title">Chat</div> : <div className="duel-tabs" role="tablist">
        <button role="tab" aria-selected={tab === "log"} className={tab === "log" ? "is-active" : ""} onClick={() => setTab("log")}>Duel log</button>
        <button role="tab" aria-selected={tab === "chat"} className={tab === "chat" ? "is-active" : ""} onClick={() => setTab("chat")}>
          Chat{unread ? <span className="duel-unread">{unread}</span> : null}
        </button>
      </div>}
      <div className="duel-loglist" ref={listRef}>
        {tab === "log"
          ? log.map((l, i) => <div key={i} className="duel-logline"><LogText text={l} onHover={onHover} /></div>)
          : chat.map((c, i) => (
            <div key={i} className={`duel-chatline ${c.system ? "is-system" : ""}`}>
              {!c.system && <b>{c.from}: </b>}<span>{c.text}</span>
            </div>
          ))}
        {tab === "log" && !log.length && <div className="muted">The duel log appears here.</div>}
        {tab === "chat" && !chat.length && <div className="muted">No messages yet.</div>}
      </div>
      {tab === "chat" && (
        <form className="duel-chatform" onSubmit={submit}>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder={canChat ? "Say something…" : "Pick a name in the lobby to chat"} disabled={!canChat} maxLength={300} aria-label="Chat message" />
          <button type="submit" disabled={!canChat || !text.trim()}>Send</button>
        </form>
      )}
    </div>
  );
}
