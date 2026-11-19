// DuelRoom's limits, timings and stored shapes (what a room keeps in Durable Object storage).
import type { BoardState, DuelStage, EngineHostStart, RpsChoice } from "../../shared/duel.ts";
import type { DuelMode } from "../../shared/types.ts";
import type { RoomSettings } from "../../shared/roomSettings.ts";
import type { Seat } from "../../shared/duelActions.ts";
import type { RarityMap } from "../../shared/rarity.ts";
import type { Profile } from "../../shared/profile.ts";
import type { OpenChainLink } from "../../shared/chain.ts";


/** DO storage key of the engine snapshot (seed + decks + responses; replayed on wake). */
export const ENGINE_KEY = "engine";
export const MAX_LOG = 500;
/** Host-runs-rules mode: whose browser runs the engine (the room creator sits in seat 0). */
export const HOST_SEAT: Seat = 0;
/** A bot opponent always takes the other seat; its prompts are answered by whoever runs the engine. */
export const BOT_SEAT: Seat = 1;
export const BOT_ID = "bot";
/** Pause before the bot answers, so the human can follow what it does. */
export const BOT_DELAY_MS = 450;
/** DO storage values are capped at 128 KiB; a snapshot is ~40 bytes per engine response. */
export const MAX_SNAPSHOT_CHARS = 120_000;

/**
 * One duel room. PHASE 3 implements manual mode (shared board state, players move cards
 * themselves). PHASE 4 adds engine mode (ocgcore WASM enforces the rules). The room's
 * mode is fixed when it is created; players can switch an engine duel to manual.
 *
 * Uses the WebSocket Hibernation API: sockets carry their identity/seat in an attachment and
 * the whole room (seats, stage, board) lives in DO storage under "room", so a hibernated or
 * restarted object resumes the duel exactly. Engine mode plugs in through ./engineHook.ts
 * (see `startDuel` and the "respond" / "switchMode" messages below).
 */

/** How long a disconnected player keeps their seat. */
export const SEAT_GRACE_MS = 5 * 60_000;
/** How long an empty room (nobody seated, nobody connected) lives. */
export const EMPTY_ROOM_MS = 10 * 60_000;
export const MAX_SOCKETS = 64;
export const MAX_CHAT = 100;
export const MAX_MSG_BYTES = 64 * 1024;
/** Clients send "ping" every 25 s (answered by the runtime without waking the object); silent sockets are dropped. */
export const STALE_MS = 75_000;

export interface SeatState {
  id: string;
  name: string;
  deck: { deckId: string; main: number[]; extra: number[]; side: number[]; rarity?: RarityMap; sleeve?: string } | null;
  connected: boolean;
  leftAt: number | null;
  bot?: boolean;
  profile?: Profile;
}

export interface ChatLine { from: string; text: string; at: number; system?: boolean }

export interface RoomData {
  roomId: string;
  name: string;
  mode: DuelMode;
  host: string;
  created_at: string;
  stage: DuelStage;
  seats: [SeatState | null, SeatState | null];
  rps: [RpsChoice | null, RpsChoice | null];
  rpsLast?: { choices: [RpsChoice, RpsChoice]; winner: Seat | null };
  chooser: Seat | null;
  winner: Seat | null;
  endReason?: string;
  rematch: [boolean, boolean];
  switchVotes: [boolean, boolean];
  board: BoardState | null;
  chat: ChatLine[];
  /** Engine mode: the prompts currently waiting for an answer (kept so reconnecting players get theirs). */
  prompts?: { seat: Seat; prompt: unknown }[];
  /** The open chain, from the public events (rules-enforced). */
  chain?: OpenChainLink[];
  /** Where this room's rules engine runs (fixed when the room is created). */
  engineRunner?: "host" | "server";
  /** Host-runs-rules mode: the duel setup the host's browser starts from. */
  hostStart?: EngineHostStart;
  /** Identity of whoever created the room (quick duels vs a bot are theirs alone). */
  ownerId?: string;
  settings?: RoomSettings;
  /** Demo duel vs the bot (decks aren't shuffled); only ever set together with a bot. */
  demo?: boolean;
  /** When the current duel started (for match history). */
  duelStartedAt?: string;
  /** Turn timer state (ms). `turn` = the board turn the clock last saw, to refill at a new turn. */
  clock?: { remaining: [number, number]; running: Seat | null; since: number; turn: number; decision?: string | null; graceUntil?: number };
}

export interface Attachment { id: string | null; name: string; seat: Seat | null; since?: number }

export const other = (p: Seat): Seat => (p === 0 ? 1 : 0);
export const BEATS: Record<RpsChoice, RpsChoice> = { rock: "scissors", paper: "rock", scissors: "paper" };
