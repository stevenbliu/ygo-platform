import type React from "react";
import type { CSSProperties, DragEvent, MouseEvent } from "react";
import { cardImage } from "../../api.ts";
import { HIDDEN_CODE, type CardInstance } from "../../../shared/duel.ts";
import { getCard } from "./useDuel.ts";
import { SleeveBack, useSleeve } from "./Sleeve.tsx";
import { RarityFoil, useRarity } from "../cards/Rarity.tsx";
import { ResolveFx } from "./ResolveFx.tsx";
import { useDuelSettings } from "./duelSettings.ts";

/** A card back in its owner's sleeve (Sleeve.tsx); no owner = the classic back. */
export function CardBack({ className = "", owner }: { className?: string; owner?: 0 | 1 }) {
  return <SleeveBack sleeve={useSleeve(owner)} className={className} />;
}

export function CardFace({ code, token, size = "small" }: { code: number; token?: boolean; size?: "small" | "full" }) {
  if (token && code <= 0) return <div className="duel-token-face"><b>TOKEN</b></div>;
  if (code === HIDDEN_CODE) return <CardBack />;
  const card = getCard(code);
  return (
    <div className="duel-card-face">
      <img src={cardImage(code, size)} alt={card?.name ?? `Card ${code}`} loading="lazy" draggable={false}
        onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }} />
      <span className="duel-card-fallback">{card?.name ?? code}</span>
    </div>
  );
}

/** Engine-mode highlight: has a legal action / can be picked now / already picked. */
export type CardMark = "actionable" | "selectable" | "picked";
/** What you can do with a card right now (Main / Battle Phase): its glow colour and the tag on it. "set" glows
 *  without a tag (Set is the quiet option). */
export type CanKind = "summon" | "activate" | "attack" | "set";
export const CAN_LABEL: Record<CanKind, string> = { summon: "Summon", activate: "Activate", attack: "Attack", set: "Set" };

interface Props {
  card: CardInstance;
  mark?: CardMark;
  /** Rules-enforced Main / Battle Phase: what you can do with it now (glow + tag). */
  can?: CanKind;
  /** Small corner badge (chain link number, counters to remove). */
  badge?: string;
  draggable?: boolean;
  selected?: boolean;
  flash?: boolean;
  onClick?: (e: MouseEvent) => void;
  onHover?: (code: number | null) => void;
  onDragStart?: (e: DragEvent) => void;
  showCounters?: boolean;
  style?: CSSProperties;
  /** Hover action buttons (rules-enforced duels): play the card straight from hover. */
  quick?: { label: string; run(): void }[];
  /** The card whose effect you're deciding for: a pulsing ring, click to go back to the decision. */
  source?: boolean;
}

// Touch: holding a card for a moment inspects it (big preview) instead of opening its menu.
const LONG_PRESS_MS = 450;
let pressTimer: ReturnType<typeof setTimeout> | undefined;
let longPressAt = 0;
const justLongPressed = () => Date.now() - longPressAt < 800;
function startPress(e: React.PointerEvent, code: number) {
  if (e.pointerType !== "touch" || code <= 0) return;
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => {
    longPressAt = Date.now();
    dispatchEvent(new CustomEvent("duel-inspect", { detail: code }));
  }, LONG_PRESS_MS);
}
const endPress = () => clearTimeout(pressTimer);

/** One card on the board / in a hand / in a viewer. Rotated for DEF, translucent when you can see your own face-down card. */
export function CardView({ card, draggable, selected, flash, onClick, onHover, onDragStart, showCounters = true, mark, can, badge, style, quick, source }: Props) {
  const known = card.code !== HIDDEN_CODE || card.token;
  const def = card.position === "def" || card.position === "faceDownDef";
  const ownFaceDown = !card.faceUp && known;
  const counters = card.counters ? Object.entries(card.counters) : [];
  const resolveStyle = useDuelSettings().resolveFx;
  const rarity = useRarity()(card.faceUp && known && !card.token ? card.code : 0, card.owner);
  const cls = ["duel-card", def ? "is-def" : "", ownFaceDown ? "is-own-facedown" : "", selected ? "is-selected" : "", flash ? "is-flash" : "", onClick ? "is-clickable" : "", mark ? `is-${mark}` : "", can ? `can-${can}` : "", source ? "is-source" : ""].join(" ");
  return (
    <div
      className={cls}
      data-uid={card.uid}
      data-foil={rarity !== "common" ? rarity : undefined}
      style={style}
      draggable={draggable}
      onDragStart={onDragStart}
      onClick={onClick ? (e) => { if (justLongPressed()) return; onClick(e); } : undefined}
      onContextMenu={(e) => { if (justLongPressed() || e.nativeEvent instanceof PointerEvent && e.nativeEvent.pointerType === "touch") { e.preventDefault(); return; } if (onClick) { e.preventDefault(); onClick(e); } }}
      onPointerDown={(e) => startPress(e, known ? card.code : 0)}
      onPointerUp={endPress}
      onPointerCancel={endPress}
      onPointerMove={(e) => { if (e.pointerType === "touch" && (Math.abs(e.movementX) > 4 || Math.abs(e.movementY) > 4)) endPress(); }}
      onMouseEnter={() => onHover?.(known ? card.code : null)}
      onMouseLeave={() => onHover?.(null)}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(e as unknown as MouseEvent); } } : undefined}
    >
      <div className="duel-card-inner">
        {known && (card.faceUp || ownFaceDown) ? <CardFace code={card.code} token={card.token} /> : <CardBack owner={card.owner} />}
        {ownFaceDown && <span className="duel-badge duel-badge-fd" title="Face-down (only you can see it)">set</span>}
        <RarityFoil rarity={rarity} type={getCard(card.code)?.type} code={card.code} />
      </div>
      {!!card.materials?.length && <span className="duel-badge duel-badge-mat" title="Xyz materials">{card.materials.length}</span>}
      {source && <span className="duel-srcfx" aria-hidden="true"><i className="sf1" /><i className="sf2" /><i className="sf3" /><i className="sf4" /></span>}
      {source && <ResolveFx style={resolveStyle} />}
      {source && <span className="duel-source-tag" aria-hidden="true">Resolving</span>}
      {can && can !== "set" && <span className={`duel-can-tag is-${can}`} aria-hidden="true">{CAN_LABEL[can]}</span>}
      {badge && <span className="duel-badge duel-badge-chain" title={/^\d+$/.test(badge) ? `Chain Link ${badge}` : badge}>{badge}</span>}
      {!!quick?.length && (
        <span className="duel-quick" role="group" aria-label="Actions">
          {quick.slice(0, 4).map((q, i) => (
            <button key={i} onClick={(e) => { e.stopPropagation(); q.run(); }} title={q.label}>{shortLabel(q.label)}</button>
          ))}
        </span>
      )}
      {showCounters && counters.length > 0 && (
        <span className="duel-badge duel-badge-ctr" title={counters.map(([k, v]) => `${k}: ${v}`).join(", ")}>
          {counters.reduce((s, [, v]) => s + v, 0)}
        </span>
      )}
    </div>
  );
}

/** Short button text for a card action ("Change to Defense Position" -> "To DEF"). */
function shortLabel(l: string): string {
  if (/^Change to Defense/.test(l)) return "To DEF";
  if (/^Change to Attack/.test(l)) return "To ATK";
  if (/^Attack \(can attack directly\)/.test(l)) return "Attack";
  if (l.length > 22) return `${l.slice(0, 20)}…`;
  return l;
}

/** Attributes as on the cards: the kanji on its coloured disc. */
const ATTRIBUTE: Record<string, [string, string]> = {
  DARK: ["闇", "#7b3fb8"], LIGHT: ["光", "#d9a400"], EARTH: ["地", "#8a5a2b"], WATER: ["水", "#2a7fd4"],
  FIRE: ["炎", "#d8452a"], WIND: ["風", "#2f9e57"], DIVINE: ["神", "#b8892a"],
};
/** Monster Types and Spell / Trap kinds as symbols (the name is in the tooltip). */
const TYPE_ICON: Record<string, string> = {
  Aqua: "💧", Beast: "🐾", "Beast-Warrior": "🐯", "Creator-God": "🌟", Cyberse: "💠", Dinosaur: "🦖", "Divine-Beast": "🌞",
  Dragon: "🐉", Fairy: "🧚", Fiend: "😈", Fish: "🐟", Illusion: "🌀", Insect: "🐞", Machine: "⚙️", Plant: "🌿",
  Psychic: "🔮", Pyro: "🔥", Reptile: "🦎", Rock: "🪨", "Sea Serpent": "🐍", Spellcaster: "🪄", Thunder: "⚡",
  Warrior: "⚔️", "Winged Beast": "🪽", Wyrm: "🐲", Zombie: "💀",
  // Spell / Trap kinds (the cards' own icons)
  "Quick-Play": "⚡", Continuous: "∞", Equip: "✚", Field: "✠", Ritual: "🔥", Counter: "↩",
};

/** A card's key facts under it in pickers and pile views: ★ Level / ✦ Rank / LINK, Tuner, its Attribute and
 *  Type as symbols, ATK / DEF (monsters); the kind of Spell / Trap. */
export function CardCaption({ code, name = false }: { code: number; name?: boolean }) {
  const c = code > 0 ? getCard(code) : null;
  if (!c) return null;
  const t = c.type ?? "";
  const monster = c.category === "Monster";
  const link = /Link/.test(t), xyz = /XYZ/i.test(t);
  const summon = ["Fusion", "Synchro", "XYZ", "Link", "Ritual", "Pendulum"].find((k) => new RegExp(k, "i").test(t));
  const attr = c.attribute ? ATTRIBUTE[c.attribute.toUpperCase()] : undefined;
  const race = c.race ?? "";
  const icon = TYPE_ICON[race];
  return (
    <span className="duel-caption">
      {name && <b className="duel-caption-name">{c.name}</b>}
      <span className="duel-caption-facts">
        {monster && (link
          ? <i className="is-link" title={`Link-${c.linkval ?? "?"}`}>LINK-{c.linkval ?? "?"}</i>
          : c.level != null && <i className={xyz ? "is-rank" : "is-level"} title={`${xyz ? "Rank" : "Level"} ${c.level}`}>{xyz ? "✦" : "★"}{c.level}</i>)}
        {attr && <i className="is-attr" style={{ background: attr[1] }} title={c.attribute ?? ""}>{attr[0]}</i>}
        {race && race !== "Normal" && <i className="is-type" title={monster ? `${race}-Type` : `${race} ${c.category}`}>{icon ?? race}</i>}
        {!monster && <i className="is-cat" title={c.category}>{c.category}</i>}
        {/Tuner/.test(t) && <i className="is-tuner">Tuner</i>}
        {summon && <i className="is-summon">{summon === "XYZ" ? "Xyz" : summon}</i>}
      </span>
      {monster && <span className="duel-caption-stats">{c.atk ?? "?"}{link ? "" : <> / {c.defense ?? "?"}</>}</span>}
    </span>
  );
}
