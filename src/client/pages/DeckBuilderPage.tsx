// PHASE 1 owns this page (deck builder for /decks/:deckId).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { Link, useParams } from "react-router-dom";
import type { Card, Deck, Section } from "../../shared/types.ts";
import { toYdk } from "../../shared/ydk.ts";
import { toYdke } from "../../shared/ydke.ts";
import { TestHand } from "../components/library/TestHand.tsx";
import { DeckStats } from "../components/library/DeckStats.tsx";
import "../components/library/deck-tools.css";
import { EngineSupportNote } from "../components/engine/EngineSupportNote.tsx";
import "../components/engine/EngineSupportNote.css";
import { isExtraDeckType, unknownCard } from "../../shared/library.ts";
import { useDeckStore } from "../store/deckStore.ts";
import { catalog, ensureCards } from "../components/cards/catalog.ts";
import { CardImage } from "../components/cards/CardImage.tsx";
import { CardPreviewLayer, preview, previewHandlers } from "../components/cards/CardPreview.tsx";
import { CARD_DRAG_TYPE, CardSearchPanel } from "../components/cards/CardSearchPanel.tsx";
import { banLimit, downloadText, safeFileName } from "../components/cards/cardInfo.ts";
import "./DeckBuilderPage.css";
import { SleevePicker, SleeveSwatch } from "../components/cards/SleevePicker.tsx";
import { LETTERINGS, LETTERING_LABEL, PICTURES, PICTURE_LABEL, RARITIES, RARITY_LABEL, RARITY_SHORT, foilOf, foilParts, isPreset, rarityLabel, rarityOf, rarityShort, type Rarity } from "../../shared/rarity.ts";
import { RarityFoil, useFoilPointer } from "../components/cards/Rarity.tsx";
import { FORMAT_LABEL, genesysExcluded, genesysPoints, genesysSummary, type DeckFormat } from "../../shared/formats.ts";
import { GENESYS_ADDITIONS_SOURCE } from "../../shared/genesysAdditions.ts";
import { GENESYS_CHECKED, GENESYS_SOURCE } from "../../shared/genesysPoints.ts";
import { FormatSelector, useDeckFormat } from "../components/library/FormatSelector.tsx";
import { cardImage } from "../api.ts";

const SECTIONS: { key: Section; label: string; min?: number; max: number }[] = [
  { key: "main", label: "Main Deck", min: 40, max: 60 },
  { key: "extra", label: "Extra Deck", max: 15 },
  { key: "side", label: "Side Deck", max: 15 },
];
const MAX_COPIES = 3;
const SERVER_MAX_IDS = 100; // per section, enforced by the accounts API
const CAT_ORDER: Record<string, number> = { Monster: 0, Spell: 1, Trap: 2 };

interface Problem { level: "error" | "warn"; text: string }
interface Menu { x: number; y: number; section: Section; index: number }
type DragData = { id: number; from?: Section; index?: number };

const cardOf = (id: number): Card => catalog.get(id) ?? unknownCard(id);

/** Which ban list to check against. */
export type BanFormat = DeckFormat;
const banOf = (c: Card, f: BanFormat) => (f === "tcg" ? c.ban_tcg : f === "ocg" ? c.ban_ocg : null);

/** Validation: section sizes, copies per card across sections, the chosen ban list, unknown ids. */
function validateDeck(deck: Pick<Deck, "main" | "extra" | "side">, get: (id: number) => Card = cardOf, format: BanFormat = "tcg"): Problem[] {
  const out: Problem[] = [];
  for (const s of SECTIONS) {
    const n = deck[s.key].length;
    if (s.min !== undefined && n < s.min) out.push({ level: "error", text: `${s.label} has ${n} cards (minimum ${s.min}).` });
    if (n > s.max) out.push({ level: "error", text: `${s.label} has ${n} cards (maximum ${s.max}).` });
    if (n > SERVER_MAX_IDS) out.push({ level: "error", text: `${s.label} has more than ${SERVER_MAX_IDS} cards and cannot be saved to an account.` });
  }
  const counts = new Map<number, number>();
  for (const id of [...deck.main, ...deck.extra, ...deck.side]) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const [id, n] of counts) {
    const c = get(id);
    const lim = Math.min(MAX_COPIES, banLimit(banOf(c, format)));
    if (format === "genesys" && genesysExcluded(c)) out.push({ level: "error", text: `${c.name}: Link and Pendulum monsters are not allowed in Genesys.` });
    if (c.category === "Unknown") out.push({ level: "warn", text: `Unknown card id ${id} (×${n}) is not in the catalogue.` });
    if (/Skill/.test(c.type ?? "")) out.push({ level: "warn", text: `${c.name} is a Skill card: not allowed in rules-enforced duels.` });
    if (n > lim) {
      const why = lim === MAX_COPIES ? `max ${MAX_COPIES} copies` : `${banOf(c, format)} in the ${FORMAT_LABEL[format]}: max ${lim}`;
      out.push({ level: "error", text: `${c.name}: ${n} ${n === 1 ? "copy" : "copies"} (${why}).` });
    }
  }
  for (const id of deck.main) {
    const c = get(id);
    if (isExtraDeckType(c.type)) { out.push({ level: "error", text: `${c.name} is an Extra Deck monster in the Main Deck.` }); break; }
  }
  for (const id of deck.extra) {
    const c = get(id);
    if (c.category !== "Unknown" && !isExtraDeckType(c.type)) { out.push({ level: "error", text: `${c.name} cannot go in the Extra Deck.` }); break; }
  }
  if (format === "genesys") {
    const points = genesysSummary(deck, get);
    if (points.total > 100) out.push({ level: "error", text: `Genesys total is ${points.total} points (standard cap 100).` });
    if (points.unknown) out.push({ level: "error", text: `Cannot verify Genesys points: ${points.unknown} unresolved card(s).` });
  }
  return out;
}

function sortSection(ids: number[]): number[] {
  return [...ids].sort((a, b) => {
    const x = cardOf(a), y = cardOf(b);
    return (CAT_ORDER[x.category] ?? 3) - (CAT_ORDER[y.category] ?? 3) || x.name.localeCompare(y.name) || a - b;
  });
}

const breakdown = (ids: number[]) => {
  const n = { Monster: 0, Spell: 0, Trap: 0 } as Record<string, number>;
  for (const id of ids) n[cardOf(id).category] = (n[cardOf(id).category] ?? 0) + 1;
  return n;
};

export function DeckBuilderPage() {
  const { deckId } = useParams();
  return <DeckBuilder deckId={deckId} />;
}

/** The deck builder for one deck: as a page, or in a modal (duel room) with `onClose` / `onSaved`. */
export function DeckBuilder({ deckId, onClose, onSaved }: { deckId: string | undefined; onClose?(): void; onSaved?(deck: Deck): void }) {
  const store = useDeckStore();
  const [deck, setDeck] = useState<Deck | null>(null);
  const [savedJson, setSavedJson] = useState("");
  const [sleeveOpen, setSleeveOpen] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [, setVersion] = useState(0);
  const [menu, setMenu] = useState<Menu | null>(null);
  /** The card menu, measured and kept on screen (it's taller than a short or zoomed window: it scrolls). */
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number; maxH: number; pv: { left: number; top: number } | null } | null>(null);
  /** The foil being hovered in the card menu: shown on a big copy of the card beside the menu. */
  const [foilPreview, setFoilPreview] = useState<Rarity | null>(null);
  const [over, setOver] = useState<Section | null>(null);
  const [tab, setTab] = useState<"search" | "deck">("deck");
  const [testHand, setTestHand] = useState(false);

  useEffect(() => {
    let alive = true;
    setState("loading");
    (async () => {
      try {
        const d = deckId ? await store.get(deckId) : null;
        if (!alive) return;
        if (!d) { setState("missing"); return; }
        await ensureCards([...d.main, ...d.extra, ...d.side]);
        if (!alive) return;
        setDeck(d);
        setSavedJson(JSON.stringify([d.name, d.main, d.extra, d.side, d.rarity ?? {}, d.sleeve ?? ""]));
        setVersion(catalog.version);
        setState("ready");
      } catch (e) {
        if (alive) { setMessage(e instanceof Error ? e.message : String(e)); setState("error"); }
      }
    })();
    return () => { alive = false; };
  }, [deckId, store]);

  const dirty = !!deck && JSON.stringify([deck.name, deck.main, deck.extra, deck.side, deck.rarity ?? {}, deck.sleeve ?? ""]) !== savedJson;
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    // scrolling the menu itself keeps it open; scrolling the page (it would leave the card behind) closes it
    const onScroll = (e: Event) => { if (!menuRef.current?.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" || e.key === "Tab") close(); };
    window.addEventListener("click", close);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    return () => { window.removeEventListener("click", close); window.removeEventListener("scroll", onScroll, true); window.removeEventListener("keydown", onKey); window.removeEventListener("resize", close); };
  }, [menu]);
  // place the menu where it fits: beside the click, inside the window, the foil preview on whichever side has room
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!menu || !el) { setMenuPos(null); return; }
    const pad = 8, gap = 12, pvW = 230, pvH = 380;
    const w = el.offsetWidth, h = el.scrollHeight + 2;
    const maxH = innerHeight - pad * 2;
    const left = Math.max(pad, Math.min(menu.x, innerWidth - w - pad));
    const top = Math.max(pad, Math.min(menu.y, innerHeight - Math.min(h, maxH) - pad));
    const pvTop = Math.max(pad, Math.min(top, innerHeight - pvH - pad));
    const pv = left + w + gap + pvW <= innerWidth - pad ? { left: left + w + gap, top: pvTop }
      : left - gap - pvW >= pad ? { left: left - gap - pvW, top: pvTop } : null;
    setMenuPos({ left, top, maxH, pv });
  }, [menu]);

  const update = useCallback((fn: (d: Deck) => Deck) => setDeck((d) => (d ? fn(d) : d)), []);
  /** One rarity for every copy of a card (Common = no entry). */
  const setRarity = (id: number, r: Rarity) => update((d) => {
    const next = { ...(d.rarity ?? {}) };
    if (r === "common") delete next[String(id)]; else next[String(id)] = r;
    return { ...d, rarity: next };
  });
  useFoilPointer();
  const counts = useMemo(() => {
    const m = new Map<number, number>();
    if (deck) for (const id of [...deck.main, ...deck.extra, ...deck.side]) m.set(id, (m.get(id) ?? 0) + 1);
    return m;
  }, [deck]);
  const [format, setFormat] = useDeckFormat();
  const problems = useMemo(() => (deck ? validateDeck(deck, cardOf, format) : []), [deck, format]);

  /** Add a card; Extra Deck monsters go to the Extra Deck unless sent to the Side Deck. */
  const add = useCallback((card: Card, target?: Section) => {
    catalog.remember([card]);
    const extra = isExtraDeckType(card.type);
    let to: Section = target ?? (extra ? "extra" : "main");
    if (to === "main" && extra) to = "extra";
    if (to === "extra" && !extra) { setMessage(`${card.name} is not an Extra Deck monster.`); return; }
    update((d) => ({ ...d, [to]: [...d[to], card.id] }));
    setMessage(null);
  }, [update]);
  const removeAt = (section: Section, index: number) => {
    preview.hide();
    update((d) => ({ ...d, [section]: d[section].filter((_, i) => i !== index) }));
  };
  const move = (from: Section, index: number, to: Section) => {
    if (from === to || !deck) return;
    const c = cardOf(deck[from][index]);
    const extra = isExtraDeckType(c.type);
    const target: Section = to === "main" && extra ? "extra" : to;
    if (target === "extra" && !extra && c.category !== "Unknown") { setMessage(`${c.name} is not an Extra Deck monster.`); return; }
    if (target === from) return;
    update((d) => ({ ...d, [from]: d[from].filter((_, i) => i !== index), [target]: [...d[target], d[from][index]] }));
  };

  const onDrop = (e: DragEvent, to: Section) => {
    e.preventDefault();
    setOver(null);
    const raw = e.dataTransfer.getData(CARD_DRAG_TYPE);
    if (!raw) return;
    const data = JSON.parse(raw) as DragData;
    if (data.from !== undefined && data.index !== undefined) move(data.from, data.index, to);
    else add(cardOf(data.id), to);
  };

  const save = async () => {
    if (!deck) return;
    setSaving(true);
    try {
      const name = deck.name.trim().slice(0, 100) || "Untitled deck";
      const saved = await store.save({ ...deck, name });
      setDeck(saved);
      onSaved?.(saved);
      setSavedJson(JSON.stringify([saved.name, saved.main, saved.extra, saved.side, saved.rarity ?? {}, saved.sleeve ?? ""]));
      const errs = validateDeck(saved).filter((p) => p.level === "error").length;
      setMessage(errs ? `Saved (with ${errs} problem${errs === 1 ? "" : "s"}).` : "Saved.");
    } catch (e) {
      setMessage(`Could not save: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  if (state === "loading") return <section><p className="muted">Loading deck…</p></section>;
  if (state === "missing") return <section><h1>Deck not found</h1><p><Link to="/decks">Back to decks</Link></p></section>;
  if (state === "error" || !deck) return <section><h1>Deck builder</h1><p className="db-error">{message}</p></section>;

  const total = deck.main.length + deck.extra.length + deck.side.length;
  const errors = problems.filter((p) => p.level === "error").length;

  return (
    <section className="deck-builder">
      {sleeveOpen && <SleevePicker value={deck.sleeve} deckCards={[...deck.main, ...deck.extra, ...deck.side]} cardName={(id) => cardOf(id).name}
        onPick={(s) => update((d) => ({ ...d, sleeve: s }))} onClose={() => setSleeveOpen(false)} />}
      {testHand && <TestHand main={deck.main} cardOf={cardOf} onClose={() => setTestHand(false)} />}
      <div className="db-head">
        {onClose
          ? <button type="button" className="db-back" onClick={() => { if (!dirty || window.confirm("Close without saving your changes?")) onClose(); }}>✕ Close</button>
          : <Link to="/decks" className="muted db-back">← Decks</Link>}
        <input className="db-name" value={deck.name} maxLength={100} onChange={(e) => update((d) => ({ ...d, name: e.target.value }))} aria-label="Deck name" />
        <div className="db-actions">
          <button type="button" className="primary" onClick={() => void save()} disabled={saving || !dirty}>{saving ? "Saving…" : dirty ? "Save" : "Saved"}</button>
          <button type="button" onClick={() => update((d) => ({ ...d, main: sortSection(d.main), extra: sortSection(d.extra), side: sortSection(d.side) }))}>Sort</button>
          <button type="button" onClick={() => setSleeveOpen(true)} title="Choose the card sleeve (card back) for this deck"><SleeveSwatch sleeve={deck.sleeve} />Sleeve</button>
          <button type="button" disabled={deck.main.length < 5} onClick={() => setTestHand(true)} title="Draw a random opening hand">Test hand</button>
          <button type="button" onClick={() => downloadText(`${safeFileName(deck.name)}.ydk`, toYdk(deck))}>Export .ydk</button>
          <button type="button" disabled={!total} title="Copy a ydke:// link (EDOPro, YGOPRODeck, Discord)" onClick={() => {
            navigator.clipboard.writeText(toYdke(deck)).then(
              () => setMessage("YDKe link copied: paste it into EDOPro, YGOPRODeck or a chat."),
              () => setMessage("Couldn't copy to the clipboard in this browser."),
            );
          }}>Copy YDKe</button>
          <button type="button" disabled={!total} onClick={() => { if (window.confirm("Remove every card from this deck?")) update((d) => ({ ...d, main: [], extra: [], side: [] })); }}>Clear</button>
        </div>
      </div>
      {message && <p className="db-message" role="status">{message}</p>}

      <div className="db-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "search"} className={tab === "search" ? "on" : ""} onClick={() => setTab("search")}>Search cards</button>
        <button type="button" role="tab" aria-selected={tab === "deck"} className={tab === "deck" ? "on" : ""} onClick={() => setTab("deck")}>
          Deck ({deck.main.length}/{deck.extra.length}/{deck.side.length}){errors ? " (!)" : ""}
        </button>
      </div>

      <div className="db-layout">
        <aside className={`db-search${tab === "search" ? " active" : ""}`}>
          <CardSearchPanel onPick={(c) => add(c)} onPickAlt={(c) => add(c, "side")} countOf={(id) => counts.get(id) ?? 0} />
        </aside>
        <div className={`db-deck${tab === "deck" ? " active" : ""}`}>
          <div className="db-format">
            <span className={`db-legal ${errors ? "is-bad" : "is-ok"}`}>{errors ? "✕ Not legal" : "✓ Legal"}{format === "none" ? "" : ` · ${FORMAT_LABEL[format]}`}</span>
            <FormatSelector format={format} onChange={setFormat} />
          </div>
          {format === "genesys" && (() => {
            const p = genesysSummary(deck, cardOf);
            return <div className="db-points" aria-live="polite">
              <strong>{p.unknown ? "At least " : ""}{p.total} / 100 points</strong>
              <span>Main {p.main} · Extra {p.extra} · Side {p.side}{p.unknown ? ` · ${p.unknown} unresolved` : ""}</span>
              <a href={GENESYS_SOURCE} target="_blank" rel="noreferrer">Official list · checked {GENESYS_CHECKED}</a>
              <a href={GENESYS_ADDITIONS_SOURCE} target="_blank" rel="noreferrer">Includes November 13 additions</a>
            </div>;
          })()}
          {total > 0 && <EngineSupportNote ids={[...deck.main, ...deck.extra, ...deck.side]} />}
          <div className={`db-problems${problems.length ? "" : " ok"}`} aria-live="polite">
            {problems.length === 0 ? (
              <span>Deck is legal{format === "none" ? "" : ` for the ${FORMAT_LABEL[format]}`} (Main {deck.main.length}, Extra {deck.extra.length}, Side {deck.side.length}).</span>
            ) : (
              <details open={problems.length <= 4}>
                <summary>{errors} problem{errors === 1 ? "" : "s"}{problems.length > errors ? `, ${problems.length - errors} warning${problems.length - errors === 1 ? "" : "s"}` : ""} (you can still save)</summary>
                <ul>{problems.map((p, i) => <li key={i} className={p.level}>{p.text}</li>)}</ul>
              </details>
            )}
          </div>
          {deck.main.length > 0 && <DeckStats main={deck.main} cardOf={cardOf} />}
          {SECTIONS.map((s) => {
            const ids = deck[s.key];
            const n = ids.length;
            const bad = (s.min !== undefined && n < s.min) || n > s.max;
            const b = breakdown(ids);
            return (
              <div key={s.key} className={`db-section${over === s.key ? " over" : ""}`}
                onDragOver={(e) => { if (e.dataTransfer.types.includes(CARD_DRAG_TYPE)) { e.preventDefault(); setOver(s.key); } }}
                onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null); }}
                onDrop={(e) => onDrop(e, s.key)}>
                <h2>
                  {s.label} <span className={bad ? "count bad" : "count"}>{n}</span>
                  <span className="muted db-breakdown">
                    {s.min !== undefined ? `${s.min}–${s.max}` : `≤${s.max}`}
                    {n > 0 && ` · ${b.Monster} monster${b.Monster === 1 ? "" : "s"} · ${b.Spell} spell${b.Spell === 1 ? "" : "s"} · ${b.Trap} trap${b.Trap === 1 ? "" : "s"}`}
                  </span>
                </h2>
                {n === 0 ? (
                  <p className="muted db-empty">Drop cards here{s.key === "side" ? " (or right-click a search result)" : ""}.</p>
                ) : (
                  <div className={`db-grid${s.key === "main" && n > 40 ? " dense" : ""}`}>
                    {ids.map((id, i) => {
                      const c = cardOf(id);
                      const lim = banLimit(banOf(c, format));
                      const over3 = (counts.get(id) ?? 0) > Math.min(MAX_COPIES, lim);
                      const rar = rarityOf(deck.rarity, id);
                      const points = genesysPoints(c);
                      return (
                        <button key={`${i}-${id}`} type="button" className={`db-card${over3 ? " illegal" : ""}`} data-foil={rar !== "common" ? rar : undefined} title={`${c.name} — click to remove, right-click for more`}
                          draggable
                          onDragStart={(e) => { e.dataTransfer.setData(CARD_DRAG_TYPE, JSON.stringify({ id, from: s.key, index: i } satisfies DragData)); e.dataTransfer.effectAllowed = "move"; }}
                          onClick={() => removeAt(s.key, i)}
                          onContextMenu={(e: MouseEvent) => { e.preventDefault(); preview.hide(); setMenu({ x: e.clientX, y: e.clientY, section: s.key, index: i }); }}
                          {...previewHandlers(c)}>
                          <CardImage card={c} />
                          <RarityFoil rarity={rar} type={c.type} code={id} />
                          {rar !== "common" && <span className={`rarity-badge r-${isPreset(rar) ? rar : "custom"}`} title={rarityLabel(rar)}>{rarityShort(rar)}</span>}
                          {format === "genesys" && (genesysExcluded(c) || (points !== null && points > 0)) && <span className="db-card-points">{genesysExcluded(c) ? "Not allowed" : points === 1 ? "1pt" : `${points} pts`}</span>}
                          {lim < 3 && <span className={`cs-ban ban-${lim}`}>{lim}</span>}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
          <p className="muted db-help">Click a card in the deck to remove it · right-click (long-press) for more · drag between sections to move.</p>
        </div>
      </div>

      {menu && deck[menu.section][menu.index] !== undefined && createPortal((() => {
        const c = cardOf(deck[menu.section][menu.index]);
        const extra = isExtraDeckType(c.type);
        const other: Section = menu.section === "side" ? (extra ? "extra" : "main") : "side";
        return (
          <>
          {/* a big copy of the card wearing the hovered foil (or its current one), beside the menu where there's room */}
          {menuPos?.pv && (() => {
            const shown = foilPreview ?? rarityOf(deck.rarity, c.id);
            return (
              <div className="db-foil-preview" style={{ left: menuPos.pv.left, top: menuPos.pv.top }} aria-hidden="true">
                <span data-foil={shown}>
                  <img src={cardImage(c.id, "full")} alt="" />
                  <RarityFoil rarity={shown} type={c.type} code={c.id} />
                </span>
                <small>{shown === "common" ? "Common" : rarityLabel(shown)}</small>
              </div>
            );
          })()}
          <div className="db-menu" role="menu" ref={menuRef} onClick={(e) => e.stopPropagation()}
            style={menuPos ? { left: menuPos.left, top: menuPos.top, maxHeight: menuPos.maxH } : { left: menu.x, top: menu.y, visibility: "hidden" }}>
            <div className="db-menu-title">{c.name}</div>
            <button type="button" role="menuitem" onClick={() => { add(c, menu.section); setMenu(null); }}>Add a copy</button>
            <button type="button" role="menuitem" onClick={() => { move(menu.section, menu.index, other); setMenu(null); }}>Move to {other === "side" ? "Side" : other === "extra" ? "Extra" : "Main"} Deck</button>
            <button type="button" role="menuitem" onClick={() => { removeAt(menu.section, menu.index); setMenu(null); }}>Remove</button>
            <div className="db-menu-rarity" role="group" aria-label="Rarity">
              <span className="muted">Rarity (all copies)</span>
              <div>
                {RARITIES.map((r) => (
                  <button key={r} type="button" className={`rarity-pick r-${r} ${rarityOf(deck.rarity, c.id) === r ? "is-on" : ""}`} title={RARITY_LABEL[r]}
                    onMouseEnter={() => setFoilPreview(r)} onMouseLeave={() => setFoilPreview(null)} onFocus={() => setFoilPreview(r)} onBlur={() => setFoilPreview(null)}
                    onClick={() => { setRarity(c.id, r); setFoilPreview(null); setMenu(null); }}>{RARITY_SHORT[r]}</button>
                ))}
              </div>
              {/* or mix your own: the name's lettering and the picture separately */}
              {(() => {
                const cur = foilParts(rarityOf(deck.rarity, c.id));
                return (
                  <div className="db-menu-foil">
                    <span className="muted">Lettering</span>
                    <div className="db-foil-chips">
                      {LETTERINGS.map((l) => {
                        const v = foilOf(l, cur.picture);
                        return (
                          <button key={l} type="button" className={`db-foil-chip ${cur.lettering === l ? "is-on" : ""}`} title={LETTERING_LABEL[l]}
                            onMouseEnter={() => setFoilPreview(v)} onMouseLeave={() => setFoilPreview(null)} onFocus={() => setFoilPreview(v)} onBlur={() => setFoilPreview(null)}
                            onClick={() => setRarity(c.id, v)}>{LETTERING_LABEL[l].replace(" (none)", "").replace(" rainbow", "")}</button>
                        );
                      })}
                    </div>
                    <span className="muted">Picture</span>
                    <div className="db-foil-chips">
                      {PICTURES.map((pic) => {
                        const v = foilOf(cur.lettering, pic);
                        return (
                          <button key={pic} type="button" className={`db-foil-chip ${cur.picture === pic ? "is-on" : ""}`} title={PICTURE_LABEL[pic]}
                            onMouseEnter={() => setFoilPreview(v)} onMouseLeave={() => setFoilPreview(null)} onFocus={() => setFoilPreview(v)} onBlur={() => setFoilPreview(null)}
                            onClick={() => setRarity(c.id, v)}>{PICTURE_LABEL[pic].replace(/ \(.*\)$/, "")}</button>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
          </>
        );
      })(), document.body)}
      <CardPreviewLayer />
    </section>
  );
}
