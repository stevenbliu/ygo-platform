import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { cardImage } from "../../api.ts";
import type {
  EngineCardRef, EngineEffectRef, EnginePlace, EnginePrompt, EngineResponse, EngineResponseBody,
} from "../../../shared/enginePrompts.ts";
import type { Position } from "../../../shared/duel.ts";
import "./EnginePrompt.css";

// Rules-engine prompt panel (phase 4). The duel page mounts it with the latest `prompt`
// message for this player and sends whatever it returns as `{ t: "respond", response }`:
//
//   {prompt && <EnginePromptPanel prompt={prompt} onRespond={(r) => send({ t: "respond", response: r })} />}
//
// `cardName` (optional) turns a passcode into a name for buttons; images use /img/small/{id}.jpg.

export interface EnginePromptPanelProps {
  prompt: EnginePrompt;
  onRespond: (response: EngineResponse) => void;
  cardName?: (code: number) => string | undefined;
  /** Error text from the server's last `{ t: "error" }`, shown under the prompt. */
  error?: string | null;
  /** Hovering a card shows the page's big preview. */
  onHover?(code: number | null): void;
  /** A card's details under its name (Level, Tuner, Type, ATK / DEF). */
  info?(code: number): ReactNode;
}

/** What the card rows need from the page (hover preview, details), without threading it through every row. */
const CardRowCtx = createContext<Pick<EnginePromptPanelProps, "onHover" | "info">>({});

const ZONE_LABEL: Record<string, string> = {
  hand: "Hand", deck: "Deck", monster: "Monster Zone", spelltrap: "S/T Zone", gy: "GY", banished: "Banished",
  extra: "Extra Deck", overlay: "Material", field: "Field Zone", pendulum: "Pendulum Zone",
};
const POSITION_LABEL: Record<Position, string> = {
  atk: "Face-up Attack", def: "Face-up Defense", faceDownDef: "Face-down Defense", faceDown: "Face-down Attack",
};

export function EnginePromptPanel(props: EnginePromptPanelProps) {
  return <CardRowCtx.Provider value={{ onHover: props.onHover, info: props.info }}><PromptPanel {...props} /></CardRowCtx.Provider>;
}

function PromptPanel({ prompt, onRespond, cardName, error }: EnginePromptPanelProps) {
  const send = (r: EngineResponseBody) => onRespond({ ...r, promptId: prompt.id } as EngineResponse);
  const name = (c: { code: number }) => (c.code ? cardName?.(c.code) ?? `#${c.code}` : "Face-down card");
  const where = (c: EngineCardRef) =>
    `${c.controller === prompt.player ? "Your" : "Opponent's"} ${ZONE_LABEL[c.location] ?? c.location}${c.location === "monster" || c.location === "spelltrap" ? ` ${c.sequence + 1}` : ""}`;

  return (
    <section className="engine-prompt" aria-live="polite">
      <header className="engine-prompt__title">{title(prompt)}</header>
      {prompt.hint && <p className="engine-prompt__hint">{prompt.hint}</p>}
      <Body prompt={prompt} send={send} name={name} where={where} />
      {error && <p className="engine-prompt__error">{error}</p>}
    </section>
  );
}

/** One-line description of what a prompt asks. */
export function title(p: EnginePrompt): string {
  switch (p.kind) {
    case "idle": return "Main Phase — choose an action";
    case "battle": return "Battle Phase — choose an action";
    case "effectYesNo": return "Activate this effect?";
    case "yesNo": return p.desc;
    case "option": return "Choose an option";
    case "selectCard": return p.min === p.max ? `Select ${p.min} card${p.min === 1 ? "" : "s"}` : `Select ${p.min}–${p.max} cards`;
    case "selectUnselect": return `Select cards (${p.min}–${p.max})`;
    case "selectChain": return p.forced ? "Choose an effect to activate" : "Chain a card or effect?";
    case "selectPlace": return p.disabling ? `Choose ${p.count} zone(s) to disable` : `Choose ${p.count === 1 ? "a zone" : `${p.count} zones`}`;
    case "selectPosition": return "Choose a battle position";
    case "selectTribute": return `Select monster(s) to Tribute (${p.min}${p.max !== p.min ? `–${p.max}` : ""})`;
    case "selectSum": return `Select cards totalling ${p.exact ? "exactly " : "at least "}${p.target}`;
    case "selectCounter": return `Remove ${p.count} counter(s)`;
    case "sort": return p.chain ? "Order the chain" : "Order these cards";
    case "rps": return "Rock, paper, scissors";
    case "announceNumber": return "Declare a number";
    case "announceRace": return `Declare ${p.count} Type(s)`;
    case "announceAttribute": return `Declare ${p.count} Attribute(s)`;
    case "announceCard": return "Declare a card name";
  }
}

type Send = (r: EngineResponseBody) => void;
interface BodyProps {
  prompt: EnginePrompt;
  send: Send;
  name: (c: { code: number }) => string;
  where: (c: EngineCardRef) => string;
}

function Body({ prompt: p, send, name, where }: BodyProps) {
  switch (p.kind) {
    case "idle": {
      const groups: [string, "summon" | "specialSummon" | "reposition" | "monsterSet" | "spellSet" | "activate", EngineCardRef[]][] = [
        ["Normal Summon", "summon", p.summons], ["Special Summon", "specialSummon", p.specialSummons],
        ["Activate", "activate", p.activates], ["Set monster", "monsterSet", p.monsterSets],
        ["Set Spell/Trap", "spellSet", p.spellSets], ["Change position", "reposition", p.repositions],
      ];
      return (
        <>
          {groups.filter(([, , cards]) => cards.length).map(([label, action, cards]) => (
            <CardRow key={action} label={label} cards={cards} name={name} where={where}
              onPick={(index) => send({ kind: "idle", action, index })} />
          ))}
          <div className="engine-prompt__actions">
            {p.canBattle && <button onClick={() => send({ kind: "idle", action: "battle" })}>Battle Phase</button>}
            {p.canEnd && <button onClick={() => send({ kind: "idle", action: "end" })}>End Turn</button>}
            {p.canShuffle && <button onClick={() => send({ kind: "idle", action: "shuffle" })}>Shuffle hand</button>}
          </div>
        </>
      );
    }
    case "battle":
      return (
        <>
          {p.attacks.length > 0 && <CardRow label="Attack with" cards={p.attacks} name={name} where={where}
            badge={(c) => ((c as { direct?: boolean }).direct ? "direct" : undefined)}
            onPick={(index) => send({ kind: "battle", action: "attack", index })} />}
          {p.activates.length > 0 && <CardRow label="Activate" cards={p.activates} name={name} where={where}
            onPick={(index) => send({ kind: "battle", action: "activate", index })} />}
          <div className="engine-prompt__actions">
            {p.canMain2 && <button onClick={() => send({ kind: "battle", action: "main2" })}>Main Phase 2</button>}
            {p.canEnd && <button onClick={() => send({ kind: "battle", action: "end" })}>End Turn</button>}
          </div>
        </>
      );
    case "effectYesNo":
    case "yesNo":
      return (
        <>
          {p.kind === "effectYesNo" && <CardRow cards={[p.card]} name={name} where={where} />}
          {p.kind === "effectYesNo" && <p className="engine-prompt__desc">{p.desc}</p>}
          <div className="engine-prompt__actions">
            <button className="primary" onClick={() => send({ kind: p.kind, yes: true })}>Yes</button>
            <button onClick={() => send({ kind: p.kind, yes: false })}>No</button>
          </div>
        </>
      );
    case "option":
      return <div className="engine-prompt__list">{p.options.map((o, i) => <button key={i} onClick={() => send({ kind: "option", index: i })}>{o}</button>)}</div>;
    case "selectCard":
    case "selectTribute":
      return <MultiPick prompt={p} send={send} name={name} where={where} />;
    case "selectSum":
      return <MultiPick prompt={p} send={send} name={name} where={where} />;
    case "selectUnselect":
      return (
        <>
          <CardRow label="Choose" cards={p.cards} name={name} where={where} onPick={(i) => send({ kind: "selectUnselect", index: i })} />
          {p.selected.length > 0 && <CardRow label="Selected (click to remove)" cards={p.selected} name={name} where={where}
            onPick={(i) => send({ kind: "selectUnselect", index: p.cards.length + i })} />}
          {(p.canFinish || p.canCancel) && <div className="engine-prompt__actions">
            <button onClick={() => send({ kind: "selectUnselect", index: null })}>{p.canFinish ? "Done" : "Cancel"}</button>
          </div>}
        </>
      );
    case "selectChain":
      return (
        <>
          <CardRow cards={p.cards} name={name} where={where} desc onPick={(i) => send({ kind: "selectChain", index: i })} />
          {!p.forced && <div className="engine-prompt__actions"><button onClick={() => send({ kind: "selectChain", index: null })}>Don't chain</button></div>}
        </>
      );
    case "selectPlace":
      return <PlacePick prompt={p} send={send} />;
    case "selectPosition":
      return <div className="engine-prompt__list">{p.positions.map((pos) => (
        <button key={pos} onClick={() => send({ kind: "selectPosition", position: pos })}>{POSITION_LABEL[pos]}</button>
      ))}</div>;
    case "selectCounter":
      return <CounterPick prompt={p} send={send} name={name} where={where} />;
    case "sort":
      return (
        <>
          <CardRow cards={p.cards} name={name} where={where} />
          <div className="engine-prompt__actions"><button onClick={() => send({ kind: "sort", order: null })}>Keep this order</button></div>
        </>
      );
    case "rps":
      return <div className="engine-prompt__actions">{(["rock", "paper", "scissors"] as const).map((c) => (
        <button key={c} onClick={() => send({ kind: "rps", choice: c })}>{c[0].toUpperCase() + c.slice(1)}</button>
      ))}</div>;
    case "announceNumber":
      return <div className="engine-prompt__list">{p.options.map((n, i) => <button key={i} onClick={() => send({ kind: "announceNumber", index: i })}>{n}</button>)}</div>;
    case "announceRace":
    case "announceAttribute":
      return <BitPick prompt={p} send={send} />;
    case "announceCard":
      return <CardCodeInput send={send} />;
  }
}

function CardRow({ label, cards, name, where, onPick, desc, badge, selected }: {
  label?: string; cards: (EngineCardRef | EngineEffectRef)[]; name: (c: { code: number }) => string; where: (c: EngineCardRef) => string;
  onPick?: (index: number) => void; desc?: boolean; badge?: (c: EngineCardRef) => string | undefined; selected?: Set<number>;
}) {
  const { onHover, info } = useContext(CardRowCtx);
  return (
    <div className="engine-prompt__row">
      {label && <div className="engine-prompt__label">{label}</div>}
      <div className="engine-prompt__cards">
        {cards.map((c, i) => (
          <button key={i} type="button" disabled={!onPick} title={`${name(c)} — ${where(c)}${"desc" in c ? `\n${c.desc}` : ""}`}
            className={`engine-card${selected?.has(i) ? " is-selected" : ""}`} onClick={() => onPick?.(i)}
            onMouseEnter={() => onHover?.(c.code || null)} onMouseLeave={() => onHover?.(null)} onFocus={() => onHover?.(c.code || null)} onBlur={() => onHover?.(null)}>
            {c.code ? <img src={cardImage(c.code)} alt="" loading="lazy" /> : <span className="engine-card__back" />}
            <span className="engine-card__name">{name(c)}</span>
            {c.code > 0 && info?.(c.code)}
            {desc && "desc" in c && <span className="engine-card__desc">{c.desc}</span>}
            {badge?.(c) && <span className="engine-card__badge">{badge(c)}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

function MultiPick({ prompt: p, send, name, where }: { prompt: Extract<EnginePrompt, { kind: "selectCard" | "selectTribute" | "selectSum" }> } & Omit<BodyProps, "prompt">) {
  const [picked, setPicked] = useState<Set<number>>(new Set());
  useEffect(() => setPicked(new Set()), [p.id]);
  const toggle = (i: number) => setPicked((s) => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; });
  const indices = [...picked].sort((a, b) => a - b);
  const sumOf = (ix: number[]) => p.kind === "selectSum" ? ix.reduce((t, i) => t + (p.cards[i].value & 0xffff), p.must.reduce((t, c) => t + (c.value & 0xffff), 0)) : 0;
  const ok = p.kind === "selectCard" ? indices.length >= p.min && indices.length <= p.max
    : p.kind === "selectTribute" ? indices.length > 0
    : p.exact ? sumOf(indices) === p.target : sumOf(indices) >= p.target;
  return (
    <>
      {p.kind === "selectSum" && p.must.length > 0 && <CardRow label="Always included" cards={p.must} name={name} where={where} />}
      <CardRow cards={p.cards} name={name} where={where} selected={picked} onPick={toggle} />
      <div className="engine-prompt__actions">
        <button className="primary" disabled={!ok} onClick={() => send(p.kind === "selectSum" ? { kind: "selectSum", indices } : { kind: p.kind, indices })}>
          Confirm{p.kind === "selectSum" ? ` (${sumOf(indices)}/${p.target})` : ` (${indices.length})`}
        </button>
        {p.kind !== "selectSum" && p.canCancel && <button onClick={() => send({ kind: p.kind, indices: null })}>Cancel</button>}
      </div>
    </>
  );
}

function PlacePick({ prompt: p, send }: { prompt: Extract<EnginePrompt, { kind: "selectPlace" }>; send: Send }) {
  const [picked, setPicked] = useState<EnginePlace[]>([]);
  useEffect(() => setPicked([]), [p.id]);
  const key = (x: EnginePlace) => `${x.controller}-${x.location}-${x.sequence}`;
  const sides = useMemo(() => [p.player, 1 - p.player].map((ctrl) => p.places.filter((x) => x.controller === ctrl)), [p]);
  const choose = (x: EnginePlace) => {
    const next = picked.some((y) => key(y) === key(x)) ? picked.filter((y) => key(y) !== key(x)) : [...picked, x];
    if (next.length === p.count) send({ kind: "selectPlace", places: next });
    else setPicked(next);
  };
  const label = (x: EnginePlace) => x.location === "monster" ? (x.sequence >= 5 ? `Extra Monster ${x.sequence - 4}` : `Monster ${x.sequence + 1}`)
    : x.location === "spelltrap" ? `S/T ${x.sequence + 1}` : x.location === "field" ? "Field" : `Pendulum ${x.sequence + 1}`;
  return (
    <>
      {sides.map((places, side) => places.length > 0 && (
        <div key={side} className="engine-prompt__row">
          <div className="engine-prompt__label">{side === 0 ? "Your zones" : "Opponent's zones"}</div>
          <div className="engine-prompt__list">{places.map((x) => (
            <button key={key(x)} className={picked.some((y) => key(y) === key(x)) ? "is-selected" : ""} onClick={() => choose(x)}>{label(x)}</button>
          ))}</div>
        </div>
      ))}
    </>
  );
}

function CounterPick({ prompt: p, send, name, where }: { prompt: Extract<EnginePrompt, { kind: "selectCounter" }> } & Omit<BodyProps, "prompt">) {
  const [counts, setCounts] = useState<number[]>(() => p.cards.map(() => 0));
  useEffect(() => setCounts(p.cards.map(() => 0)), [p.id, p.cards]);
  const total = counts.reduce((a, b) => a + b, 0);
  return (
    <>
      {p.cards.map((c, i) => (
        <label key={i} className="engine-prompt__counter">
          {name(c)} ({where(c)}, {c.available} available)
          <input type="number" min={0} max={c.available} value={counts[i]}
            onChange={(e) => setCounts((xs) => xs.map((x, j) => (j === i ? Math.max(0, Math.min(c.available, Number(e.target.value) | 0)) : x)))} />
        </label>
      ))}
      <div className="engine-prompt__actions">
        <button className="primary" disabled={total !== p.count} onClick={() => send({ kind: "selectCounter", counts })}>Remove {total}/{p.count}</button>
      </div>
    </>
  );
}

const RACES = ["Warrior", "Spellcaster", "Fairy", "Fiend", "Zombie", "Machine", "Aqua", "Pyro", "Rock", "Winged Beast", "Plant", "Insect",
  "Thunder", "Dragon", "Beast", "Beast-Warrior", "Dinosaur", "Fish", "Sea Serpent", "Reptile", "Psychic", "Divine-Beast", "Creator God",
  "Wyrm", "Cyberse", "Illusion"];
const ATTRIBUTES = ["EARTH", "WATER", "FIRE", "WIND", "LIGHT", "DARK", "DIVINE"];
const bitName = (names: string[], v: number) => names[Math.round(Math.log2(v))] ?? `0x${v.toString(16)}`;

function BitPick({ prompt: p, send }: { prompt: Extract<EnginePrompt, { kind: "announceRace" | "announceAttribute" }>; send: Send }) {
  const [picked, setPicked] = useState<number[]>([]);
  useEffect(() => setPicked([]), [p.id]);
  const names = p.kind === "announceRace" ? RACES : ATTRIBUTES;
  const toggle = (v: number) => setPicked((xs) => (xs.includes(v) ? xs.filter((x) => x !== v) : [...xs, v]));
  return (
    <>
      <div className="engine-prompt__list">{p.available.map((v) => (
        <button key={v} className={picked.includes(v) ? "is-selected" : ""} onClick={() => toggle(v)}>{bitName(names, v)}</button>
      ))}</div>
      <div className="engine-prompt__actions">
        <button className="primary" disabled={picked.length !== p.count} onClick={() => send({ kind: p.kind, values: picked })}>Declare</button>
      </div>
    </>
  );
}

function CardCodeInput({ send }: { send: Send }) {
  const [code, setCode] = useState("");
  return (
    <form className="engine-prompt__actions" onSubmit={(e) => { e.preventDefault(); if (Number(code) > 0) send({ kind: "announceCard", code: Number(code) }); }}>
      <input inputMode="numeric" placeholder="Card passcode" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
      <button className="primary" type="submit" disabled={!Number(code)}>Declare</button>
    </form>
  );
}
