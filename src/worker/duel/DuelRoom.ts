import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env.ts";
import type { ClientMsg, DuelStage, RoomInfo, ServerMsg, SessionInfo } from "../../shared/duel.ts";
import type { DuelMode } from "../../shared/types.ts";
import { DEFAULT_SETTINGS, cleanSettings, formatTimeControl, type RoomSettings } from "../../shared/roomSettings.ts";
import { skillCardProblem } from "./engine/deckCheck.ts";
import { validateDeck, type DuelAction, type Seat } from "../../shared/duelActions.ts";
import { cryptoRng, createBoard } from "./manual/board.ts";
import { ActionError, applyAction } from "./manual/reducer.ts";
import { maskBoard } from "./manual/mask.ts";
import { identityFromHeaders } from "./identity.ts";
import { ENGINE_NOTICE, engineAvailable } from "./engineHook.ts";
import { botResponse } from "./engine/bot.ts";
import { BadResponse, restoreRoomEngine, startRoomEngine, type RoomEngineSession, type RoomEngineUpdate } from "./engine/roomHook.ts";
import { eventsFor } from "./engine/EngineDuel.ts";
import { stepClock } from "../../shared/clock.ts";
import { MAX_PRESENTATION_MS, presentationMs } from "../../shared/pacing.ts";
import { cleanRarities, type RarityMap } from "../../shared/rarity.ts";
import { DEFAULT_SLEEVE, cleanSleeve } from "../../shared/sleeves.ts";
import { cleanProfile } from "../../shared/profile.ts";
import { publicChain, publicDeciding } from "./engine/publicView.ts";
import { ENGINE_KEY, MAX_LOG, HOST_SEAT, BOT_SEAT, BOT_ID, BOT_DELAY_MS, MAX_SNAPSHOT_CHARS, SEAT_GRACE_MS, EMPTY_ROOM_MS, MAX_SOCKETS, MAX_CHAT, MAX_MSG_BYTES, STALE_MS, other, BEATS } from "./roomState.ts";
import type { ChatLine, RoomData, Attachment } from "./roomState.ts";
import { RoomError, checkHostUpdate } from "./hostUpdate.ts";
export { SEAT_GRACE_MS } from "./roomState.ts";


export class DuelRoom extends DurableObject<Env> {
  private room: RoomData | null = null;
  /** Live engine (WASM state). Rebuilt from storage[ENGINE_KEY] by replay after hibernation. */
  private engine: RoomEngineSession | null = null;
  /** Engine calls await D1, so other messages could interleave: run them one at a time. */
  private engineQueue: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get<RoomData>("room")) ?? null;
    });
  }

  // ---------- RPC from the Worker ----------

  async init(input: {
    roomId: string; name: string; mode: DuelMode; host: string; ownerId?: string; settings?: RoomSettings;
    /** Demo duel vs the bot: decks keep their order (combo pieces in the opening hands). */
    demo?: boolean;
    /** Quick duel: seat a bot with this deck straight away (rules-enforced only). */
    bot?: { deckId: string; main: number[]; extra: number[]; side: number[]; rarity?: RarityMap; sleeve?: string };
  }): Promise<void> {
    if (this.room) throw new Error("room already exists");
    const { bot, ...info } = input;
    this.room = {
      ...info, created_at: new Date().toISOString(), stage: "lobby", rps: [null, null],
      seats: [null, bot ? { id: BOT_ID, name: "Bot", connected: true, leftAt: null, bot: true, deck: bot } : null],
      chooser: null, winner: null, rematch: [false, false], switchVotes: [false, false], board: null, chat: [],
      engineRunner: this.env.ENGINE_RUNNER === "server" ? "server" : "host",
    };
    await this.save();
    await this.updateIndex();
    await this.ctx.storage.setAlarm(Date.now() + EMPTY_ROOM_MS);
  }

  // ---------- WebSocket entry ----------

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const room = this.room;
    if (!room) {
      server.accept();
      server.send(JSON.stringify({ t: "error", message: "Room not found. It may have closed." } satisfies ServerMsg));
      server.close(4404, "room not found");
      return new Response(null, { status: 101, webSocket: client });
    }
    await this.pruneStale();
    if (this.live().length >= MAX_SOCKETS) {
      server.accept();
      server.send(JSON.stringify({ t: "error", message: "This room is full." } satisfies ServerMsg));
      server.close(4429, "room full");
      return new Response(null, { status: 101, webSocket: client });
    }

    const ident = identityFromHeaders(request);
    const seatIdx = ident ? room.seats.findIndex((s) => s?.id === ident.id) : -1;
    const seat = seatIdx >= 0 ? (seatIdx as Seat) : null;
    if (seat === null && !this.settings().spectators && room.seats[0] && room.seats[1]) {
      server.accept();
      server.send(JSON.stringify({ t: "error", message: "This room doesn't allow spectators." } satisfies ServerMsg));
      server.close(4403, "no spectators");
      return new Response(null, { status: 101, webSocket: client });
    }
    if (seat !== null) {
      // same player in another tab: the newest connection takes over the seat
      for (const ws of this.ctx.getWebSockets()) {
        const a = this.att(ws);
        if (a.seat === seat) {
          a.seat = null;
          ws.serializeAttachment(a);
          this.send(ws, { t: "error", message: "You opened this duel in another tab; this tab is now spectating." });
        }
      }
      const s = room.seats[seat]!;
      const wasAway = !s.connected;
      s.connected = true;
      s.leftAt = null;
      if (wasAway && room.stage === "duel") this.systemLine(`${s.name} reconnected.`);
    }
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id: ident?.id ?? null, name: ident?.name ?? "Anonymous", seat, since: Date.now() } satisfies Attachment);

    this.send(server, { t: "room", room: this.roomInfo(), you: seat });
    this.send(server, { t: "session", session: this.session(seat) });
    if (room.board) this.send(server, { t: "state", state: maskBoard(room.board, seat) });
    if (seat !== null && room.stage === "duel" && room.mode === "engine") this.send(server, { t: "prompt", prompt: this.promptFor(seat) });
    if (seat === HOST_SEAT && room.mode === "engine" && this.hostMode() && room.stage === "duel") await this.sendHostJob(server);
    for (const line of room.chat) this.send(server, { t: "chat", ...line });
    await this.save();
    this.broadcastSession();
    await this.updateIndex();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (!this.room) return;
    if (typeof raw !== "string" || raw.length > MAX_MSG_BYTES) return this.send(ws, { t: "error", message: "Message too large." });
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.send(ws, { t: "error", message: "Bad message." });
    }
    try {
      await this.handle(ws, msg);
    } catch (e) {
      if (e instanceof ActionError || e instanceof RoomError) this.send(ws, { t: "error", message: e.message });
      else {
        console.error("DuelRoom error", e);
        this.send(ws, { t: "error", message: "Something went wrong in the room." });
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, "bye"); } catch { /* already closed */ }
    await this.onLeave(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.onLeave(ws);
  }

  private async onLeave(ws: WebSocket) {
    const room = this.room;
    if (!room) return;
    const a = this.att(ws);
    if (a.seat !== null) {
      const stillHere = this.live().some((w) => w !== ws && this.att(w).seat === a.seat);
      const s = room.seats[a.seat];
      if (s && !stillHere) {
        s.connected = false;
        s.leftAt = Date.now();
        if (room.stage === "duel") this.systemLine(`${s.name} disconnected. Their seat is kept for ${SEAT_GRACE_MS / 60_000} minutes.`);
      }
    }
    await this.save();
    this.broadcastSession(ws);
    await this.scheduleAlarm(ws);
    await this.updateIndex(ws);
  }

  /** Seat expiry and empty-room cleanup. */
  async alarm(): Promise<void> {
    const room = this.room;
    if (!room) return;
    this.tickClock();   // a turn timer may have run out
    const now = Date.now();
    for (const p of [0, 1] as Seat[]) {
      const s = room.seats[p];
      if (!s || s.connected || s.leftAt === null || now - s.leftAt < SEAT_GRACE_MS) continue;
      if (room.stage === "duel") this.finish(other(p), `${s.name} left the duel.`);
      this.freeSeat(p);
      this.systemLine(`${s.name} left the room.`);
    }
    await this.pruneStale();
    const sockets = this.live().length;
    if (!room.seats.some((s) => s && !s.bot) && sockets === 0) {
      await this.closeRoom();
      return;
    }
    await this.save();
    this.broadcastAll();
    await this.updateIndex();
    await this.scheduleAlarm();
  }

  // ---------- messages ----------

  private async handle(ws: WebSocket, msg: ClientMsg) {
    const room = this.room!;
    const a = this.att(ws);
    switch (msg.t) {
      case "join": return this.join(ws, a, msg);
      case "chat": {
        if (!a.id) throw new RoomError("Pick a display name in the lobby to chat.");
        const text = String(msg.text ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 300);
        if (!text) return;
        const line: ChatLine = { from: a.seat === null ? `${a.name} (spectator)` : a.name, text, at: Date.now() };
        this.pushChat(line);
        await this.save();
        return this.broadcast({ t: "chat", ...line });
      }
      case "rps": {
        const p = this.seated(a);
        if (room.stage !== "rps") throw new RoomError("Not choosing rock-paper-scissors right now.");
        if (!(msg.choice in BEATS)) throw new RoomError("Pick rock, paper or scissors.");
        room.rps[p] = msg.choice;
        const [c0, c1] = room.rps;
        if (c0 && c1) {
          const winner: Seat | null = c0 === c1 ? null : BEATS[c0] === c1 ? 0 : 1;
          room.rpsLast = { choices: [c0, c1], winner };
          room.rps = [null, null];
          const names = room.seats.map((s) => s!.name);
          if (winner === null) this.systemLine(`Rock-paper-scissors: both picked ${c0}. Pick again!`);
          else {
            this.systemLine(`Rock-paper-scissors: ${names[0]} ${c0}, ${names[1]} ${c1}. ${names[winner]} wins and chooses who goes first.`);
            room.stage = "choose";
            room.chooser = winner;
          }
        }
        break;
      }
      case "coinToss": {
        this.seated(a);
        if (room.stage !== "rps") throw new RoomError("Not deciding turn order right now.");
        const winner = cryptoRng.int(2) as Seat;
        room.rps = [null, null];
        room.stage = "choose";
        room.chooser = winner;
        this.systemLine(`${a.name} tossed a coin: ${winner === 0 ? "Heads" : "Tails"} — ${room.seats[winner]!.name} chooses who goes first.`);
        break;
      }
      case "chooseOrder": {
        const p = this.seated(a);
        if (room.stage !== "choose" || room.chooser !== p) throw new RoomError("It is not your choice to make.");
        await this.startDuel(msg.first ? p : other(p));
        return;
      }
      case "concede": {
        if (room.mode === "engine" && room.stage === "duel") {
          const p = this.seated(a);
          this.finish(other(p), `${room.seats[p]!.name} conceded.`);
          break;
        }
        return this.doAction(ws, a, { type: "concede" });
      }
      case "action": {
        const action = msg.action as DuelAction;
        if (action?.type === "rematch") return this.rematch(a);
        return this.doAction(ws, a, action);
      }
      case "rematch": return this.rematch(a);
      case "leave": {
        const p = this.seated(a);
        const name = room.seats[p]!.name;
        if (room.stage === "duel") this.finish(other(p), `${name} left the duel.`);
        this.freeSeat(p);
        a.seat = null;
        ws.serializeAttachment(a);
        this.systemLine(`${name} left the seat.`);
        this.send(ws, { t: "room", room: this.roomInfo(), you: null });
        break;
      }
      case "switchMode": {
        const p = this.seated(a);
        if (msg.mode !== "manual") throw new RoomError("Only switching to manual mode is supported.");
        if (room.mode === "manual") throw new RoomError("This room is already in manual mode.");
        if (this.hasBot()) throw new RoomError("The bot can only play with the rules engine. Remove the bot to play manually.");
        room.switchVotes[p] = true;
        this.systemLine(`${a.name} wants to play this room manually.`);
        if (room.switchVotes[0] && room.switchVotes[1]) {
          if (room.stage === "duel" && this.hostMode()) {
            // the host's last update is the engine's full (unmasked) board
            if (room.board) room.board.log = [...room.board.log, "Switched to manual mode: players now move cards themselves."].slice(-MAX_LOG);
            await this.dropEngine();
          } else if (room.stage === "duel") {
            // Mid-duel: the engine's current board becomes the manual board.
            await this.withEngine(async () => {
              const board = (await this.engineSession()).exportBoard();
              board.log = [...(room.board?.log ?? []), "Switched to manual mode: players now move cards themselves."].slice(-MAX_LOG);
              room.board = board;
            });
            await this.dropEngine();
          }
          room.mode = "manual";
          room.switchVotes = [false, false];
          this.systemLine("Both players agreed: this room is now a manual duel.");
          this.advanceLobby();
          this.broadcast({ t: "room", room: this.roomInfo(), you: null }, (w) => this.att(w).seat);
        }
        break;
      }
      case "respond": {
        const p = this.seated(a);
        if (room.mode !== "engine" || room.stage !== "duel") throw new RoomError("No rules-enforced duel is running.");
        if (this.hostMode()) {
          if (!room.prompts?.some((x) => x.seat === p)) throw new RoomError("There's nothing for you to choose right now.");
          const hosts = this.socketsOf(HOST_SEAT);
          if (!hosts.length) throw new RoomError(`Waiting for ${room.seats[HOST_SEAT]?.name ?? "the host"} to reconnect: their browser runs the rules.`);
          for (const ws of hosts) this.send(ws, { t: "engineRespond", seat: p, response: msg.response });
          return;
        }
        await this.withEngine(async () => {
          if (room.stage !== "duel" || room.mode !== "engine") throw new RoomError("No rules-enforced duel is running.");
          const session = await this.engineSession();
          let update: RoomEngineUpdate;
          try {
            update = await session.respond(p, msg.response);
          } catch (e) {
            if (e instanceof BadResponse) throw new RoomError(e.message);
            throw e;
          }
          await this.applyEngineUpdate(update);
        });
        return;
      }
      case "addBot": {
        const p = this.seated(a);
        if (p !== HOST_SEAT) throw new RoomError("Only the room's host can add a bot.");
        if (room.mode !== "engine") throw new RoomError("Bots play rules-enforced rooms only.");
        if (room.stage !== "lobby" && room.stage !== "finished") throw new RoomError("You can add a bot before the duel starts.");
        if (room.seats[BOT_SEAT] && !room.seats[BOT_SEAT]!.bot) throw new RoomError("Someone is already sitting there.");
        const err = validateDeck(msg) ?? await skillCardProblem(this.env.DB, msg);
        if (err) throw new RoomError(`Bot deck: ${err}`);
        if (room.stage === "finished") this.resetToLobby();
        room.seats[BOT_SEAT] = {
          id: BOT_ID, name: "Bot", connected: true, leftAt: null, bot: true,
          deck: { deckId: String(msg.deckId ?? "").slice(0, 64), main: msg.main, extra: msg.extra, side: msg.side ?? [], rarity: cleanRarities((msg as { rarity?: unknown }).rarity), sleeve: cleanSleeve((msg as { sleeve?: unknown }).sleeve) },
        };
        this.systemLine("A bot took the empty seat. (It plays random legal moves.)");
        this.advanceLobby();
        await this.botActs();
        break;
      }
      case "settings": {
        // the host (seat 0) sets the room's rules any time before a duel starts
        const p = this.seated(a);
        if (p !== HOST_SEAT || room.seats[p]?.bot) throw new RoomError("Only the room's host can change its rules.");
        if (room.stage === "duel") throw new RoomError("The rules can be changed between duels.");
        const before = this.settings(), next = cleanSettings(msg.settings);
        if (JSON.stringify(before) === JSON.stringify(next)) return;
        room.settings = next;
        const what: string[] = [];
        if (formatTimeControl(before) !== formatTimeControl(next)) what.push(`time: ${formatTimeControl(next)}`);
        if (before.startingLP !== next.startingLP) what.push(`${next.startingLP.toLocaleString("en-US")} LP`);
        if (before.spectators !== next.spectators) what.push(next.spectators ? "spectators allowed" : "no spectators");
        if (before.visibility !== next.visibility) what.push(next.visibility === "public" ? "listed in the lobby" : "unlisted");
        if (what.length) this.systemLine(`${a.name} changed the room's rules: ${what.join(", ")}.`);
        break;
      }
      case "sleeve": {
        // cosmetic: the back of your cards, any time (everyone sees it)
        const p = this.seated(a);
        const deck = room.seats[p]?.deck;
        if (!deck) throw new RoomError("Choose a deck first.");
        deck.sleeve = cleanSleeve(msg.sleeve);
        break;
      }
      case "removeBot": {
        const p = this.seated(a);
        if (p !== HOST_SEAT || !this.hasBot()) throw new RoomError("There's no bot to remove.");
        if (room.stage === "duel") throw new RoomError("Concede the duel first.");
        this.freeSeat(BOT_SEAT);
        this.systemLine("The bot left the room.");
        break;
      }
      case "hostUpdate": {
        if (a.seat !== HOST_SEAT || !this.hostMode() || room.mode !== "engine" || room.stage !== "duel") {
          throw new RoomError("Only the host's rules engine can update this duel.");
        }
        const update = checkHostUpdate(msg.update);
        const snap = JSON.stringify(msg.snapshot ?? null);
        await this.applyEngineUpdate(update, snap.length <= MAX_SNAPSHOT_CHARS ? msg.snapshot : undefined);
        return;
      }
      case "hostError": {
        if (a.seat !== HOST_SEAT || !this.hostMode()) throw new RoomError("Only the host's rules engine can report errors.");
        const seat: Seat = msg.seat === 1 ? 1 : 0;
        for (const ws of this.socketsOf(seat)) {
          this.send(ws, { t: "error", message: String(msg.message ?? "That answer isn't allowed.").slice(0, 200) });
          this.send(ws, { t: "prompt", prompt: this.promptFor(seat) });   // the client hid it when answering
        }
        return;
      }
      default:
        throw new RoomError("Unknown message.");
    }
    await this.save();
    this.broadcastAll();
    await this.updateIndex();
  }

  private async join(ws: WebSocket, a: Attachment, msg: Extract<ClientMsg, { t: "join" }>) {
    const room = this.room!;
    if (!a.id) throw new RoomError("Pick a display name in the lobby before joining.");
    const err = validateDeck(msg) ?? (room.mode === "engine" ? await skillCardProblem(this.env.DB, msg) : null);
    if (err) throw new RoomError(err);
    const deck = { deckId: String(msg.deckId ?? "").slice(0, 64), main: msg.main, extra: msg.extra, side: msg.side ?? [], rarity: cleanRarities((msg as { rarity?: unknown }).rarity), sleeve: cleanSleeve((msg as { sleeve?: unknown }).sleeve) };
    let seat = a.seat;
    if (seat === null) {
      if (room.stage !== "lobby" && room.stage !== "finished") throw new RoomError("This duel has already started — you can spectate.");
      const free = room.seats.findIndex((s) => s === null);
      if (free < 0) throw new RoomError("Both seats are taken — you can spectate.");
      if (this.hasBot() && room.ownerId && a.id !== room.ownerId) throw new RoomError("This is a private duel against a bot. You can watch it.");
      seat = free as Seat;
      room.seats[seat] = { id: a.id, name: a.name, deck, connected: true, leftAt: null, profile: cleanProfile((msg as { profile?: unknown }).profile) };
      a.seat = seat;
      ws.serializeAttachment(a);
      this.systemLine(`${a.name} took a seat.`);
      if (room.stage === "finished") this.resetToLobby();
    } else {
      if (room.stage !== "lobby" && room.stage !== "finished") throw new RoomError("You can only change decks between duels.");
      room.seats[seat]!.deck = deck;
      room.seats[seat]!.profile = cleanProfile((msg as { profile?: unknown }).profile);
      this.systemLine(`${a.name} ${room.stage === "finished" ? "side-decked / changed deck" : "changed deck"}.`);
    }
    this.advanceLobby();
    this.send(ws, { t: "room", room: this.roomInfo(), you: seat });
    await this.botActs();
    if ((room.stage as DuelStage) === "duel") return;   // the bot started the duel (startDuel saved and broadcast)
    await this.save();
    this.broadcastAll();
    await this.updateIndex();
  }

  /** lobby -> rps once both seats have decks (manual mode, or engine mode once the engine exists). */
  private advanceLobby() {
    const room = this.room!;
    if (room.stage !== "lobby") return;
    if (!room.seats[0]?.deck || !room.seats[1]?.deck) return;
    if (room.mode === "engine" && !engineAvailable()) return; // waiting for both to vote "play manually"
    room.stage = "rps";
    room.rps = [null, null];
    room.rpsLast = undefined;
    if (!room.seats.some((x) => x?.bot)) this.systemLine("Both players are ready. Rock-paper-scissors (or toss a coin) to decide who chooses turn order.");
  }

  private async startDuel(first: Seat) {
    const room = this.room!;
    room.duelStartedAt = new Date().toISOString();
    const [s0, s1] = room.seats;
    if (!s0?.deck || !s1?.deck) throw new RoomError("Both players need a deck.");
    if (room.mode === "engine" && this.hostMode()) {
      await this.dropEngine();
      room.hostStart = {
        names: [s0.name, s1.name],
        decks: [{ main: s0.deck.main, extra: s0.deck.extra }, { main: s1.deck.main, extra: s1.deck.extra }],
        first,
        seed: [...crypto.getRandomValues(new Uint32Array(8))],
        startingLP: this.settings().startingLP,
        ...(room.demo && this.hasBot() ? { stacked: true } : {}),
      };
      this.startClock();
      room.board = null;
      room.stage = "duel";
      room.chooser = null;
      room.winner = null;
      room.endReason = undefined;
      room.rematch = [false, false];
      room.switchVotes = [false, false];
      this.systemLine(`The rules-enforced duel begins! ${room.seats[first]!.name} goes first. The rules run in ${s0.name}'s browser.`);
      await this.save();
      this.broadcastAll();
      await this.updateIndex();
      for (const ws of this.socketsOf(HOST_SEAT)) await this.sendHostJob(ws);
      return;
    }
    if (room.mode === "engine") {
      await this.withEngine(async () => {
        await this.dropEngine();
        const session = startRoomEngine(this.env, {
          names: [s0.name, s1.name],
          decks: [{ main: s0.deck!.main, extra: s0.deck!.extra }, { main: s1.deck!.main, extra: s1.deck!.extra }],
          first,
          seed: crypto.getRandomValues(new Uint32Array(8)),
          startingLP: this.settings().startingLP,
          stacked: !!room.demo && this.hasBot(),
        });
        this.startClock();
        let update: RoomEngineUpdate;
        try {
          update = await session.start();
        } catch (e) {
          console.error("engine start failed", e);
          throw new RoomError("The rules engine could not start this duel. You can both switch this room to manual.");
        }
        this.engine = session;
        room.board = null;
        room.stage = "duel";
        room.chooser = null;
        room.winner = null;
        room.endReason = undefined;
        room.rematch = [false, false];
        room.switchVotes = [false, false];
        this.systemLine(`The rules-enforced duel begins! ${room.seats[first]!.name} goes first.`);
        await this.applyEngineUpdate(update);
        await this.updateIndex();
      });
      return;
    }
    room.board = createBoard([s0.name, s1.name], [s0.deck, s1.deck], first, cryptoRng, this.settings().startingLP);
    this.startClock();
    room.stage = "duel";
    room.chooser = null;
    room.winner = null;
    room.endReason = undefined;
    room.rematch = [false, false];
    this.systemLine(`The duel begins! ${room.seats[first]!.name} goes first.`);
    await this.save();
    this.broadcastAll();
    await this.updateIndex();
  }

  private async doAction(ws: WebSocket, a: Attachment, action: DuelAction) {
    const room = this.room!;
    const p = this.seated(a);
    if (room.stage !== "duel" || !room.board) throw new RoomError("The duel is not running.");
    if (room.mode !== "manual") throw new RoomError("Board actions are only for manual duels.");
    const r = applyAction(room.board, p, action, cryptoRng);
    room.board = r.board;
    if (r.finished) this.finish(r.finished.winner, r.finished.reason);
    await this.save();
    this.broadcastAll();
    if (r.peek) this.send(ws, { t: "peek", ...r.peek });
    for (const event of r.events) this.broadcast({ t: "event", event });
    if (r.finished) await this.updateIndex();
  }

  private async rematch(a: Attachment) {
    const room = this.room!;
    const p = this.seated(a);
    if (room.stage !== "finished") throw new RoomError("Rematch is offered when a duel ends.");
    if (!room.seats[0] || !room.seats[1]) throw new RoomError("Waiting for an opponent to sit down.");
    room.rematch[p] = true;
    if (this.hasBot()) room.rematch[BOT_SEAT] = true;
    this.systemLine(`${a.name} wants a rematch.`);
    if (room.rematch[0] && room.rematch[1]) {
      room.rematch = [false, false];
      room.rpsLast = undefined;
      if (room.winner === null) {
        room.stage = "rps";
        room.rps = [null, null];
        this.systemLine("Rematch! Rock-paper-scissors again.");
      } else {
        room.stage = "choose";
        room.chooser = other(room.winner); // the loser of the last duel picks
        this.systemLine(`Rematch! ${room.seats[room.chooser]!.name} lost the last duel and chooses who goes first.`);
      }
      await this.botActs();
      if ((room.stage as DuelStage) === "duel") return;   // the bot started it (startDuel saved and broadcast)
    }
    await this.save();
    this.broadcastAll();
    await this.updateIndex();
  }

  // ---------- engine mode ----------

  private withEngine<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.engineQueue.then(fn, fn);
    this.engineQueue = run.catch(() => undefined);
    return run;
  }

  /** The live engine, rebuilt by replaying the stored snapshot after hibernation or eviction. */
  private async engineSession(): Promise<RoomEngineSession> {
    if (this.engine) return this.engine;
    const snap = await this.ctx.storage.get(ENGINE_KEY);
    const session = snap ? restoreRoomEngine(this.env, snap) : null;
    if (!session) throw new RoomError("The rules engine lost this duel's state. You can both switch this room to manual to keep playing.");
    await session.start();
    this.engine = session;
    return session;
  }

  private hostMode(): boolean {
    const room = this.room;
    return !!room && (room.engineRunner ?? (this.env.ENGINE_RUNNER === "server" ? "server" : "host")) === "host";
  }

  private socketsOf(seat: Seat): WebSocket[] {
    return this.ctx.getWebSockets().filter((w) => this.att(w).seat === seat);
  }

  /** Tell the host's browser to start the duel's engine, or resume it from the stored moves. */
  private async sendHostJob(ws: WebSocket) {
    const room = this.room!;
    const snapshot = await this.ctx.storage.get(ENGINE_KEY);
    this.send(ws, { t: "engineHost", start: room.hostStart, snapshot: snapshot ?? undefined, bot: this.hasBot() ? BOT_SEAT : undefined });
  }

  private async dropEngine() {
    this.engine = null;
    if (this.room) this.room.prompts = [];
    await this.ctx.storage.delete(ENGINE_KEY);
  }

  private promptFor(seat: Seat): unknown {
    return this.room?.prompts?.find((x) => x.seat === seat)?.prompt ?? null;
  }

  /** Store, persist and broadcast one engine step. */
  private async applyEngineUpdate(u: RoomEngineUpdate, hostSnapshot?: unknown) {
    const room = this.room!;
    const log = [...(room.board?.log ?? []), ...(u.log ?? [])].slice(-MAX_LOG);
    if (u.board) room.board = u.board;
    if (room.board) room.board.log = log;
    room.prompts = u.prompts ?? [];
    // the open chain as everyone sees it (public events: seat 0's view with seat 0's secrets removed)
    if (u.events) room.chain = publicChain(room.chain ?? [], u.events);
    if (u.finished) room.chain = [];
    if (u.finished) {
      this.finish(u.finished.winner, u.finished.reason);
      await this.dropEngine();
    } else if (hostSnapshot !== undefined) {
      await this.ctx.storage.put(ENGINE_KEY, hostSnapshot);
    } else if (this.engine) {
      await this.ctx.storage.put(ENGINE_KEY, this.engine.snapshot());
    }
    // the clock waits while the players watch what just happened (shared/pacing.ts)
    const show = Math.max(presentationMs(u.events?.[0]), presentationMs(u.events?.[1]));   // each seat's view
    if (room.clock && show) {
      const now = Date.now();
      room.clock.graceUntil = Math.min(now + MAX_PRESENTATION_MS, Math.max(room.clock.graceUntil ?? 0, now) + show);
    }
    await this.save();
    this.sendEngineEvents(u.events);
    this.broadcastAll();
    if (u.finished) await this.updateIndex();
    // server-run engine: the room plays the bot's turns (in host mode the host's engine does)
    const botPrompt = !this.hostMode() && this.hasBot() ? room.prompts?.find((x) => x.seat === BOT_SEAT) : undefined;
    if (botPrompt) setTimeout(() => void this.botRespond(botPrompt.prompt), BOT_DELAY_MS);
  }

  private settings(): RoomSettings {
    return this.room?.settings ?? DEFAULT_SETTINGS;
  }

  /** Who the duel is waiting on right now (whose clock runs): manual = the turn player,
   *  rules-enforced = whoever has a prompt. Bots and host-engine thinking time don't count. */
  private waitingOn(): Seat | null {
    const room = this.room!;
    if (room.stage !== "duel" || !room.board) return null;
    const seat = room.mode === "engine" ? room.prompts?.[0]?.seat ?? null : room.board.turnPlayer;
    return seat !== null && room.seats[seat]?.bot ? null : seat;
  }

  /** The clock's starting time per player (ms), 0 = no timer. */
  private clockStartMs(): number {
    const s = this.settings();
    return s.timeControl === "chess" ? s.bankSec * 1000 : s.timeControl === "turn" ? s.turnTimerSec * 1000 : 0;
  }

  /** The decision the clock is waiting on ("seat:prompt id"; manual: "seat:log length"), to credit the
   *  chess increment to whoever answered it. */
  private decisionKey(seat: Seat | null): string | null {
    const room = this.room!;
    if (seat === null || !room.board) return null;
    if (room.mode === "engine") {
      const p = room.prompts?.find((x) => x.seat === seat)?.prompt as { id?: number } | undefined;
      return p?.id !== undefined ? `${seat}:${p.id}` : null;
    }
    return `${seat}:${room.board.log.length}`;
  }

  private startClock() {
    const room = this.room!;
    const ms = this.clockStartMs();
    room.clock = ms ? { remaining: [ms, ms], running: null, since: Date.now(), turn: 0, decision: null } : undefined;
  }

  /** Charge elapsed time to whoever was on the clock, refill at a new turn, switch the clock,
   *  and end the duel if someone ran out. Called on every broadcast and on alarms. */
  private tickClock() {
    const room = this.room!;
    const c = room.clock;
    if (!c || room.stage !== "duel" || !room.board) return;
    const out = stepClock(c, this.settings(), Date.now(), room.board.turn, this.waitingOn(), (seat) => this.decisionKey(seat));
    if (out !== null) {
      this.finish(other(out), `${room.seats[out]?.name ?? "A player"} ran out of time.`);
      void this.save();
      void this.updateIndex();
      return;
    }
    // persist right away: the room hibernates between messages and must not wake with a stale clock
    void this.ctx.storage.put("room", room);
  }

  private hasBot(): boolean {
    return !!this.room?.seats[BOT_SEAT]?.bot;
  }

  private async botRespond(prompt: unknown) {
    await this.withEngine(async () => {
      const room = this.room;
      if (!room || room.stage !== "duel" || room.mode !== "engine") return;
      if (!room.prompts?.some((x) => x.seat === BOT_SEAT && x.prompt === prompt)) return;   // already answered / superseded
      const session = await this.engineSession();
      await this.applyEngineUpdate(await session.respond(BOT_SEAT, botResponse(prompt as Parameters<typeof botResponse>[0], Math.random)));
    }).catch((e) => console.error("bot move failed", e));
  }

  /** The bot's part of the pre-duel flow: a coin decides who picks turn order, and it picks at random. */
  private async botActs() {
    const room = this.room!;
    if (!this.hasBot() || !room.seats[HOST_SEAT]) return;
    if (room.stage === "rps") {
      const winner = cryptoRng.int(2) as Seat;
      room.rps = [null, null];
      room.stage = "choose";
      room.chooser = winner;
      this.systemLine(`Coin toss: ${room.seats[winner]!.name} chooses who goes first.`);
    }
    if (room.stage === "choose" && room.chooser === BOT_SEAT) {
      const first = cryptoRng.int(2) as Seat;
      this.systemLine(`The bot chooses to go ${first === BOT_SEAT ? "first" : "second"}.`);
      await this.startDuel(first);
    }
  }

  /** Each seat gets its own (masked) events for animations; spectators get the public ones. Sent before the new state. */
  private sendEngineEvents(events: RoomEngineUpdate["events"]) {
    if (!events || (!events[0].length && !events[1].length)) return;
    const pub = eventsFor(events[0], 1);   // seat 0's view with seat 0's secrets removed too
    for (const ws of this.ctx.getWebSockets()) {
      const seat = this.att(ws).seat;
      const list = seat === null ? pub : events[seat];
      if (list.length) this.send(ws, { t: "engineEvents", events: list });
    }
  }

  private finish(winner: Seat | null, reason: string) {
    const room = this.room!;
    if (room.stage === "duel") void this.recordMatch(winner, reason);
    if (room.clock) room.clock.running = null;
    if (room.mode === "engine") {
      room.prompts = [];
      room.hostStart = undefined;
      this.engine = null;
      void this.ctx.storage.delete(ENGINE_KEY);
    }
    room.stage = "finished";
    room.winner = winner;
    room.endReason = reason;
    room.rematch = [false, false];
    const text = winner === null ? `${reason} The duel is a draw.` : `${reason} ${room.seats[winner]?.name ?? room.board?.players[winner].name} wins!`;
    room.board?.log.push(text);
    this.systemLine(text);
  }

  /** Match history: one row per finished duel (never fails the duel if the write fails). */
  private async recordMatch(winner: Seat | null, reason: string) {
    const room = this.room!;
    const [a, b] = room.seats;
    try {
      await this.env.DB.prepare(
        `INSERT INTO matches (room_id, mode, p0_id, p0_name, p0_deck, p1_id, p1_name, p1_deck, winner, reason, turns, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        room.roomId, room.mode,
        a?.bot ? BOT_ID : a?.id ?? null, a?.name ?? null, a?.deck?.deckId ?? null,
        b?.bot ? BOT_ID : b?.id ?? null, b?.name ?? null, b?.deck?.deckId ?? null,
        winner, reason.slice(0, 200), room.board?.turn ?? null, room.duelStartedAt ?? null, new Date().toISOString(),
      ).run();
    } catch (e) {
      console.error("match history", e);
    }
  }

  private freeSeat(p: Seat) {
    const room = this.room!;
    room.seats[p] = null;
    room.rps = [null, null];
    room.rematch = [false, false];
    room.switchVotes[p] = false;
    if (room.stage !== "duel") this.resetToLobby();
    for (const ws of this.ctx.getWebSockets()) {
      const a = this.att(ws);
      if (a.seat === p) { a.seat = null; ws.serializeAttachment(a); }
    }
  }

  private resetToLobby() {
    const room = this.room!;
    room.stage = "lobby";
    room.chooser = null;
    room.rps = [null, null];
    room.rpsLast = undefined;
    room.rematch = [false, false];
    room.board = null;
    room.winner = null;
    room.endReason = undefined;
    room.prompts = [];
    room.hostStart = undefined;
    this.engine = null;
    void this.ctx.storage.delete(ENGINE_KEY);
  }

  private async closeRoom() {
    await this.env.DB.prepare("DELETE FROM rooms WHERE room_id = ?").bind(this.room!.roomId).run().catch((e) => console.error("rooms index", e));
    await this.ctx.storage.deleteAll();
    this.room = null;
  }

  // ---------- helpers ----------

  private seated(a: Attachment): Seat {
    if (a.seat === null) throw new RoomError("Spectators can't do that.");
    return a.seat;
  }

  private att(ws: WebSocket): Attachment {
    return (ws.deserializeAttachment() as Attachment | null) ?? { id: null, name: "Anonymous", seat: null };
  }

  private pushChat(line: ChatLine) {
    const chat = this.room!.chat;
    chat.push(line);
    if (chat.length > MAX_CHAT) chat.splice(0, chat.length - MAX_CHAT);
  }

  /** Room notice: stored in chat history and broadcast. */
  private systemLine(text: string) {
    const line: ChatLine = { from: "Room", text, at: Date.now(), system: true };
    this.pushChat(line);
    this.broadcast({ t: "chat", ...line });
  }

  private async save() {
    if (this.room) await this.ctx.storage.put("room", this.room);
  }

  private async scheduleAlarm(except?: WebSocket) {
    const room = this.room;
    if (!room) return;
    const times = room.seats.filter((s) => s && !s.connected && s.leftAt !== null).map((s) => s!.leftAt! + SEAT_GRACE_MS);
    if (this.live().filter((w) => w !== except).length === 0) times.push(Date.now() + (room.seats.some(Boolean) ? SEAT_GRACE_MS : 60_000));
    const c = room.clock;
    if (c && c.running !== null && room.stage === "duel") times.push(c.since + c.remaining[c.running] - 1000);   // fire just as the clock runs out
    if (times.length) await this.ctx.storage.setAlarm(Math.min(...times) + 1000);
  }

  /** Sockets that pinged (or connected) recently. */
  private live(): WebSocket[] {
    const now = Date.now();
    return this.ctx.getWebSockets().filter((w) => {
      const pinged = this.ctx.getWebSocketAutoResponseTimestamp(w)?.getTime() ?? 0;
      return now - Math.max(pinged, this.att(w).since ?? 0) < STALE_MS;
    });
  }

  /** Close sockets whose client vanished without a close frame (e.g. aborted handshakes). */
  private async pruneStale() {
    const live = new Set(this.live());
    for (const ws of this.ctx.getWebSockets()) {
      if (live.has(ws)) continue;
      try { ws.close(4408, "timeout"); } catch { /* gone */ }
      await this.onLeave(ws);
    }
  }

  private spectatorCount(except?: WebSocket) {
    return this.live().filter((w) => w !== except && this.att(w).seat === null).length;
  }

  private roomInfo(except?: WebSocket): RoomInfo {
    const room = this.room!;
    const both = !!room.seats[0] && !!room.seats[1];
    return {
      roomId: room.roomId, name: room.name, mode: room.mode, host: room.host,
      players: room.seats.filter(Boolean).map((s) => s!.name),
      status: !both ? "waiting" : room.stage === "finished" ? "finished" : "dueling",
      created_at: room.created_at, spectators: this.spectatorCount(except), settings: this.settings(),
    };
  }

  private session(viewer: Seat | null, except?: WebSocket): SessionInfo {
    const room = this.room!;
    const seats = room.seats.map((s) => s && {
      name: s.name, connected: s.connected, ready: !!s.deck, bot: s.bot || undefined,
      deck: s.deck ? { main: s.deck.main.length, extra: s.deck.extra.length, side: s.deck.side.length } : undefined,
      rarity: s.deck?.rarity && Object.keys(s.deck.rarity).length ? s.deck.rarity : undefined,
      sleeve: s.deck?.sleeve && s.deck.sleeve !== DEFAULT_SLEEVE ? s.deck.sleeve : undefined,
      profile: s.profile,
    }) as SessionInfo["seats"];
    const showNotice = room.mode === "engine" && !engineAvailable();
    return {
      stage: room.stage, mode: room.mode, seats, spectators: this.spectatorCount(except),
      rps: {
        mine: viewer === null ? null : room.rps[viewer],
        opponentPicked: viewer === null ? false : room.rps[other(viewer)] !== null,
        last: room.rpsLast,
      },
      chooser: room.chooser, winner: room.winner, endReason: room.endReason, rematch: room.rematch,
      settings: this.settings(),
      timer: room.clock && this.clockStartMs() && (room.stage === "duel" || room.stage === "finished")
        ? {
          mode: this.settings().timeControl === "chess" ? "chess" : "turn", incrementSec: this.settings().incrementSec,
          limitSec: this.clockStartMs() / 1000, remaining: room.clock.remaining, running: room.clock.running, since: room.clock.since, serverNow: Date.now(),
        }
        : undefined,
      engineNotice: showNotice ? ENGINE_NOTICE : undefined,
      switchVotes: room.mode === "engine" ? room.switchVotes : undefined,
      engineHost: room.mode === "engine" && this.hostMode() ? HOST_SEAT : undefined,
      // what the duel is waiting on, for everyone (the hint only: never the cards)
      deciding: room.mode === "engine" && room.stage === "duel" ? publicDeciding(room.prompts) : undefined,
      chain: room.mode === "engine" && room.stage === "duel" && room.chain?.length ? room.chain : undefined,
    };
  }

  private send(ws: WebSocket, msg: ServerMsg) {
    try { ws.send(JSON.stringify(msg)); } catch { /* socket gone */ }
  }

  private broadcast(msg: ServerMsg, youOf?: (ws: WebSocket) => Seat | null) {
    for (const ws of this.ctx.getWebSockets()) {
      this.send(ws, youOf && msg.t === "room" ? { ...msg, you: youOf(ws) } : msg);
    }
  }

  private broadcastSession(except?: WebSocket) {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      this.send(ws, { t: "session", session: this.session(this.att(ws).seat, except) });
    }
  }

  /** Session + masked board to everyone. */
  private broadcastAll() {
    const room = this.room;
    if (!room) return;
    this.tickClock();
    void this.scheduleAlarm();
    for (const ws of this.ctx.getWebSockets()) {
      const seat = this.att(ws).seat;
      this.send(ws, { t: "session", session: this.session(seat) });
      if (room.board) this.send(ws, { t: "state", state: maskBoard(room.board, seat) });
      if (seat !== null && room.mode === "engine") this.send(ws, { t: "prompt", prompt: room.stage === "duel" ? this.promptFor(seat) : null });
    }
  }

  private async updateIndex(except?: WebSocket) {
    const room = this.room;
    if (!room) return;
    const info = this.roomInfo(except);
    try {
      await this.env.DB.prepare(
        `INSERT INTO rooms (room_id, name, mode, host, players, status, spectators, created_at, updated_at, settings)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(room_id) DO UPDATE SET name = excluded.name, mode = excluded.mode, players = excluded.players,
           status = excluded.status, spectators = excluded.spectators, updated_at = excluded.updated_at, settings = excluded.settings`,
      ).bind(info.roomId, info.name, info.mode, info.host, JSON.stringify(info.players), this.hasBot() || this.settings().visibility === "unlisted" ? "unlisted" : info.status, info.spectators ?? 0, info.created_at, new Date().toISOString(), JSON.stringify(this.settings())).run();
    } catch (e) {
      console.error("rooms index update failed", e);
    }
  }
}
