// Client-side duel plumbing: identity (guest name / account), the room websocket, card data cache.

import { SCENE_PREFIX, SceneSocket, isScene } from "./sceneSocket.ts";
import { applyChainEvents, chainFromSession, type ChainLink } from "./ChainStack.tsx";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, lookupCards } from "../../api.ts";
import type { BoardState, CardInstance, ClientMsg, DuelEvent, RoomInfo, ServerMsg, SessionInfo } from "../../../shared/duel.ts";
import type { Seat } from "../../../shared/duelActions.ts";
import type { Card } from "../../../shared/types.ts";
import type { EngineEvent, EnginePrompt } from "../../../shared/enginePrompts.ts";

// ---------- identity ----------

export interface DuelIdentity { id: string; name: string; guest: boolean }

export function useDuelIdentity() {
  const [identity, setIdentity] = useState<DuelIdentity | null>(null);
  const [requireAccount, setRequireAccount] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    api<{ identity: DuelIdentity | null; requireAccount: boolean }>("/api/duel/me")
      .then((r) => { setIdentity(r.identity); setRequireAccount(r.requireAccount); })
      .catch(() => setIdentity(null))
      .finally(() => setLoading(false));
  }, []);
  const setName = useCallback(async (name: string) => {
    const r = await api<{ identity: DuelIdentity }>("/api/duel/guest", { method: "POST", json: { name } });
    setIdentity(r.identity);
    return r.identity;
  }, []);
  return { identity, requireAccount, loading, setName };
}

// ---------- websocket ----------

export interface ChatLine { from: string; text: string; at?: number; system?: boolean }
export interface Toast { id: number; text?: string; event?: DuelEvent; error?: boolean }

export interface DuelConn {
  status: "connecting" | "open" | "closed" | "gone";
  room: RoomInfo | null;
  you: Seat | null;
  session: SessionInfo | null;
  board: BoardState | null;
  chat: ChatLine[];
  peek: { title: string; cards: CardInstance[] } | null;
  toasts: Toast[];
  /** Rules-enforced mode: the engine's open question for you (null when you have nothing to answer). */
  prompt: EnginePrompt | null;
  /** Host-runs-rules mode, on the host's page: what the local rules engine is doing (null = running fine). */
  hostStatus: string | null;
}

let toastSeq = 0;

export interface DuelSocketHooks {
  /** Called synchronously before a new board is stored (the DOM still shows `prev`), with the
   *  engine events that led to it (rules-enforced mode; null in manual mode). For animations. */
  beforeState?(prev: BoardState | null, next: BoardState, events: EngineEvent[] | null): void;
  /** Resolves when the board update just stored has played out (animator.settle). Until then the next
   *  update, prompt, toast and session change wait their turn: each moment gets its beat (shared/pacing.ts). */
  settle?(): Promise<void>;
}

/** Messages that play out in order on the board (the rest, like chat, apply at once). */
const FLOW = new Set<ServerMsg["t"]>(["state", "engineEvents", "prompt", "event", "session"]);

export function useDuelSocket(roomId: string, hooks?: DuelSocketHooks) {
  const hooksRef = useRef(hooks);
  hooksRef.current = hooks;
  const boardRef = useRef<BoardState | null>(null);
  const eventsRef = useRef<EngineEvent[] | null>(null);
  // engine events since the previous prompt, and the ones that led to the current prompt (auto-pass)
  const sincePrompt = useRef<EngineEvent[]>([]);
  const promptEvents = useRef<EngineEvent[]>([]);
  // the open chain (rules-enforced duels), for the chain display
  const [chain, setChain] = useState<ChainLink[]>([]);
  const [conn, setConn] = useState<DuelConn>({ status: "connecting", room: null, you: null, session: null, board: null, chat: [], peek: null, toasts: [], prompt: null, hostStatus: null });
  const wsRef = useRef<WebSocket | null>(null);
  const queue = useRef<ClientMsg[]>([]);
  // host-runs-rules mode: the engine running in this browser (only on the host's page)
  const host = useRef<Promise<import("../engine/hostRuntime.ts").EngineHost> | null>(null);

  const toast = useCallback((t: Omit<Toast, "id">, ms = 4000) => {
    const id = ++toastSeq;
    setConn((c) => ({ ...c, toasts: [...c.toasts.slice(-4), { ...t, id }] }));
    setTimeout(() => setConn((c) => ({ ...c, toasts: c.toasts.filter((x) => x.id !== id) })), ms);
  }, []);

  useEffect(() => {
    let stopped = false;
    let retry = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // heartbeat: the room answers "ping" with "pong" without waking up, and drops silent sockets
    const ping = setInterval(() => { if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send("ping"); }, 25_000);
    // updates play out one at a time: after a board update, the next message waits until it has settled
    let handle: (msg: ServerMsg) => void = () => undefined;
    const inbox: ServerMsg[] = [];
    let draining = false;
    const drain = async () => {
      if (draining) return;
      draining = true;
      try {
        while (inbox.length && !stopped) {
          const m = inbox.shift()!;
          const hadBoard = !!boardRef.current;
          handle(m);
          if (m.t === "state" && hadBoard && hooksRef.current?.settle) await hooksRef.current.settle();
        }
      } finally { draining = false; }
    };
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      // a scene fixture (/duel/scene-<name>): a recorded moment replayed, no server (sceneSocket.ts)
      const ws = isScene(roomId) ? (new SceneSocket(roomId.slice(SCENE_PREFIX.length)) as unknown as WebSocket)
        : new WebSocket(`${proto}://${location.host}/ws/room/${encodeURIComponent(roomId)}`);
      wsRef.current = ws;
      setConn((c) => ({ ...c, status: "connecting" }));
      ws.onopen = () => {
        retry = 0;
        setConn((c) => ({ ...c, status: "open", chat: [] }));
        for (const m of queue.current.splice(0)) ws.send(JSON.stringify(m));
      };
      ws.onmessage = (e) => {
        let msg: ServerMsg;
        try { msg = JSON.parse(e.data); } catch { return; }
        // the scene recorder (scripts/ux/record-scenes.mjs) listens here
        (window as { __duelMsg?: (m: ServerMsg) => void }).__duelMsg?.(msg);
        if (FLOW.has(msg.t)) { inbox.push(msg); void drain(); } else handle(msg);
      };
      handle = (msg: ServerMsg) => {
        switch (msg.t) {
          case "room": setConn((c) => ({ ...c, room: msg.room, you: msg.you })); break;
          case "session":
            if (msg.session.stage === "lobby") boardRef.current = null;
            setConn((c) => ({ ...c, session: msg.session, board: msg.session.stage === "lobby" ? null : c.board }));
            // loaded in the middle of a chain: take the server's copy (events keep it current from here)
            if (msg.session.chain?.length) { const links = msg.session.chain; setChain((cur) => (cur.length ? cur : chainFromSession(links))); }
            else if (msg.session.stage !== "duel") setChain([]);
            break;
          case "state": {
            const events = eventsRef.current;
            eventsRef.current = null;
            try { hooksRef.current?.beforeState?.(boardRef.current, msg.state, events); } catch (err) { console.warn("beforeState", err); }
            boardRef.current = msg.state;
            setConn((c) => ({ ...c, board: msg.state }));
            break;
          }
          case "engineEvents": {
            const events = (Array.isArray(msg.events) ? msg.events : []) as EngineEvent[];
            eventsRef.current = [...(eventsRef.current ?? []), ...events];
            sincePrompt.current.push(...events);
            if (events.some((e) => e.e.startsWith("chain"))) setChain((c) => applyChainEvents(c, events));
            // coins and dice get the same toasts as manual mode
            for (const ev of events) {
              if (ev.e === "coin") ev.results.forEach((heads) => toast({ event: { kind: "coin", player: ev.player, heads } }));
              if (ev.e === "dice") ev.results.forEach((value) => toast({ event: { kind: "dice", player: ev.player, value } }));
            }
            break;
          }
          case "chat": setConn((c) => ({ ...c, chat: [...c.chat.slice(-199), msg] })); break;
          case "peek": setConn((c) => ({ ...c, peek: { title: msg.title, cards: msg.cards } })); break;
          case "event": toast({ event: msg.event }, msg.event.kind === "reveal" ? 7000 : 4000); break;
          case "prompt":
            if (msg.prompt) { promptEvents.current = sincePrompt.current; sincePrompt.current = []; }
            setConn((c) => ({ ...c, prompt: (msg.prompt as EnginePrompt | null) ?? null }));
            break;
          case "engineHost":
          case "engineRespond": {
            host.current ??= import("../engine/hostRuntime.ts").then((m) => new m.EngineHost(
              (out) => sendRef.current(out),
              (hostStatus) => setConn((c) => ({ ...c, hostStatus })),
            ));
            const m = msg;
            host.current.then((h) => (m.t === "engineHost" ? h.run({ start: m.start, snapshot: m.snapshot, bot: m.bot }) : h.respond(m.seat, m.response)))
              .catch((err) => setConn((c) => ({ ...c, hostStatus: `Could not load the rules engine: ${(err as Error)?.message ?? err}` })));
            break;
          }
          case "error": toast({ text: msg.message, error: true }); break;
          default: break;
        }
      };
      ws.onclose = (e) => {
        if (wsRef.current === ws) wsRef.current = null;
        inbox.length = 0;   // the server sends the whole state again on reconnect
        if (stopped) return;
        if (e.code === 4404) { setConn((c) => ({ ...c, status: "gone" })); return; }
        setConn((c) => ({ ...c, status: "closed" }));
        timer = setTimeout(connect, Math.min(10_000, 1000 * 2 ** retry++));
      };
    };
    // deferred so React StrictMode's mount/unmount/mount does not open a throwaway socket
    timer = setTimeout(connect, 0);
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(ping);
      wsRef.current?.close(1000, "leaving");
    };
  }, [roomId, toast]);

  const sendRef = useRef<(m: ClientMsg) => void>(() => {});
  const send = useCallback((m: ClientMsg) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
    else queue.current.push(m);
    // the answer is on its way: hide the prompt until the server sends the next one
    if (m.t === "respond") setConn((c) => ({ ...c, prompt: null }));
  }, []);
  sendRef.current = send;

  const clearPeek = useCallback(() => setConn((c) => ({ ...c, peek: null })), []);
  return { conn, send, toast, clearPeek, promptEvents, chain };
}

// ---------- card data ----------

const cache = new Map<number, Card | null>();
const listeners = new Set<() => void>();
let pending = new Set<number>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function request(codes: number[]) {
  for (const c of codes) if (c > 0 && !cache.has(c)) pending.add(c);
  if (!pending.size || flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = undefined;
    const batch = [...pending];
    pending = new Set();
    for (const c of batch) cache.set(c, null); // mark in flight
    try {
      const r = await lookupCards(batch);
      const byId = new Map(r.cards.map((c) => [c.id, c]));
      for (const raw of batch) cache.set(raw, byId.get(r.alias[raw] ?? raw) ?? null);
    } catch {
      for (const c of batch) cache.delete(c);
    }
    listeners.forEach((l) => l());
  }, 30);
}

export function getCard(code: number): Card | null {
  return cache.get(code) ?? null;
}

/** Re-renders when any of `codes` arrive; returns a lookup function. */
export function useCardData(codes: number[]): (code: number) => Card | null {
  const [, setTick] = useState(0);
  const key = [...new Set(codes)].sort().join(",");
  useEffect(() => {
    const l = () => setTick((t) => t + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  useEffect(() => { request(key ? key.split(",").map(Number) : []); }, [key]);
  return getCard;
}

/** Every visible code on a board (for prefetching card data). */
export function boardCodes(b: BoardState | null, extra: CardInstance[] = []): number[] {
  if (!b) return extra.map((c) => c.code);
  const out: number[] = [];
  const add = (c: CardInstance | null) => { if (c) { out.push(c.code); c.materials?.forEach(add); } };
  for (const p of b.players) [...p.hand, ...p.extra, ...p.gy, ...p.banished, ...p.monster, ...p.spelltrap, ...p.pendulum, p.field].forEach(add);
  b.extraMonster.forEach(add);
  extra.forEach(add);
  for (const line of b.log.slice(-200)) for (const m of line.matchAll(/\[\[(\d+)\]\]/g)) out.push(Number(m[1]));
  return out.filter((c) => c > 0);
}

// ---------- card classification (for menus / default drops) ----------

export const isExtraDeckCard = (c: Card | null) => !!c?.type && /Fusion|Synchro|XYZ|Link/i.test(c.type);
export const isPendulum = (c: Card | null) => !!c?.type && /Pendulum/i.test(c.type);
export const isFieldSpell = (c: Card | null) => c?.category === "Spell" && c.race === "Field";
