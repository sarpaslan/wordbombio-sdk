import type { Client, Room } from "@colyseus/sdk";
import { Unpackr } from "msgpackr";
import { joinError, WordBombError, type ErrorCode } from "./errors.js";
import { GameRoom, type GameRoomContext, type RawState, type RestartInfo } from "./room.js";
import type { RoomListing } from "./types.js";
import { list, num, record, sleep, str } from "./util.js";

const LOBBY_TIMEOUT = 5000;
const PROFILE_SEND_WAIT = 1500;
const REJOIN_DELAY = 2000;
const RESTART_FIRST_DELAY = 3000;
const RESTART_MAX_DELAY = 30000;
const RESTART_ATTEMPTS = 10;
const RESTART_FATAL = new Set<ErrorCode>(["BANNED", "KICKED", "BOTS_NOT_ALLOWED", "AUTH_FAILED", "APP_NO_ROOMS", "BOT_ROOM_LIMIT"]);

export interface JoinOptions {
  spectate?: boolean;
  language?: string;
}

export interface CreateRoomOptions {
  mode?: number;
  language?: string;
  multiLanguage?: boolean;
  private?: boolean;
  hearts?: number;
  timer?: number;
  maxPlayers?: number;
  config?: Record<string, unknown>;
}

export interface RoomsContext extends Omit<GameRoomContext, "restarting"> {
  locale: string;
  rejoin: boolean;
  isApp(): boolean;
  adopted(room: GameRoom): void;
  failed(e: unknown): void;
}

function normalizeId(roomId: string): string {
  const id = roomId.trim();
  return id.length === 4 ? id.toUpperCase() : id;
}

const appNoRooms = () => new WordBombError("APP_NO_ROOMS", "applications never join rooms, they get them from bot.apps");

const unpackr = new Unpackr({ useRecords: true, structuredClone: false });

export class Lobby {
  constructor(
    private readonly client: Client,
    private readonly locale: string,
  ) {}

  async rooms(): Promise<RoomListing[]> {
    return this.with(async (lobby) => {
      const snapshot = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new WordBombError("TIMEOUT", "the lobby sent no room list")), LOBBY_TIMEOUT);
        lobby.onMessage("rooms", (m: unknown) => {
          clearTimeout(timer);
          resolve(m);
        });
      });
      const packed = record(snapshot).b;
      const rows: unknown = packed instanceof Uint8Array ? unpackr.unpack(packed) : Array.isArray(packed) ? unpackr.unpack(Uint8Array.from(packed)) : [];
      const out: RoomListing[] = [];
      for (const entry of list(rows)) {
        const row = record(entry);
        const md = record(row.metadata);
        if (md.ranked || md.tournament || md.player1) continue;
        out.push({
          id: str(row.roomId),
          name: str(md.name),
          players: num(row.clients),
          mode: num(md.mode),
          eventRoom: !!md.eventType,
          multiLanguage: md.mlang === true,
          language: str(md.language),
          started: md.started === true,
          guestsAllowed: md.g !== false,
        });
      }
      return out;
    });
  }

  async send(type: string, payload: unknown): Promise<void> {
    await this.with(async (lobby) => {
      await sleep(800);
      lobby.send(type, payload);
      await sleep(PROFILE_SEND_WAIT);
    });
  }

  private async with<T>(fn: (lobby: Room) => Promise<T>): Promise<T> {
    const lobby = await this.client.joinOrCreate("lobby", { locale: this.locale }).catch((e: unknown) => {
      throw joinError(e);
    });
    lobby.onMessage("*", () => {});
    try {
      return await fn(lobby);
    } finally {
      lobby.leave().catch(() => {});
    }
  }
}

export class Rooms {
  private readonly open = new Map<string, GameRoom>();
  private readonly rejoins = new Set<ReturnType<typeof setTimeout>>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly client: Client,
    private readonly ctx: RoomsContext,
  ) {}

  get all(): GameRoom[] {
    return [...this.open.values()];
  }

  get(roomId: string): GameRoom | null {
    return this.open.get(normalizeId(roomId)) ?? null;
  }

  join(roomId: string, opts: JoinOptions = {}): Promise<GameRoom> {
    const id = normalizeId(roomId);
    if (this.ctx.isApp()) return Promise.reject(appNoRooms());
    return this.serial(async () => this.open.get(id) ?? this.adopt(await this.connectById(id, opts), opts));
  }

  create(opts: CreateRoomOptions = {}): Promise<GameRoom> {
    if (this.ctx.isApp()) return Promise.reject(appNoRooms());
    return this.serial(async () => {
      const room = await this.adopt(await this.connectNew(opts), {});
      if (opts.multiLanguage && opts.language) await room.settings({ language: opts.language });
      return room;
    });
  }

  async leave(roomId: string): Promise<void> {
    await this.get(roomId)?.leave();
  }

  async leaveAll(): Promise<void> {
    for (const timer of this.rejoins) clearTimeout(timer);
    this.rejoins.clear();
    await Promise.all(this.all.map((room) => room.leave()));
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private connectById(id: string, opts: JoinOptions): Promise<Room<RawState>> {
    return this.client.joinById<RawState>(id, { locale: opts.language ?? this.ctx.locale, spectate: !!opts.spectate }).catch((e: unknown) => {
      throw joinError(e);
    });
  }

  private connectNew(opts: CreateRoomOptions): Promise<Room<RawState>> {
    const config: Record<string, unknown> = { ...opts.config };
    if (opts.hearts !== undefined) config.heart = opts.hearts;
    if (opts.timer !== undefined) config.timer = opts.timer;
    if (opts.maxPlayers !== undefined) config.maxPlayer = opts.maxPlayers;
    return this.client
      .create<RawState>("my_room", {
        locale: opts.multiLanguage ? "mlang" : opts.language ?? this.ctx.locale,
        open: !opts.private,
        mode: opts.mode ?? 0,
        config,
      })
      .catch((e: unknown) => {
        throw joinError(e);
      });
  }

  private later(ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.rejoins.delete(timer);
      fn();
    }, ms);
    this.rejoins.add(timer);
  }

  private recover(info: RestartInfo, opts: JoinOptions, attempt: number): void {
    this.later(Math.min(RESTART_FIRST_DELAY * 2 ** attempt, RESTART_MAX_DELAY), () => {
      if (this.open.has(info.roomId)) return;
      this.serial(async () => this.open.get(info.roomId) ?? this.adopt(await this.reconnect(info, opts), opts)).catch((e: unknown) => {
        const code = e instanceof WordBombError ? e.code : null;
        if (attempt + 1 >= RESTART_ATTEMPTS || (code && RESTART_FATAL.has(code))) this.ctx.failed(e);
        else this.recover(info, opts, attempt + 1);
      });
    });
  }

  private async reconnect(info: RestartInfo, opts: JoinOptions): Promise<Room<RawState>> {
    try {
      return await this.connectById(info.roomId, { ...opts, language: info.locale });
    } catch (e) {
      if (!(e instanceof WordBombError) || (e.code !== "ROOM_NOT_FOUND" && e.code !== "JOIN_FAILED")) throw e;
    }
    const config: Record<string, unknown> = { multiLang: info.multiLanguage, chain: info.chainStyle };
    if (info.scenario) config.scenario = info.scenario;
    const created = await this.client
      .create<RawState>("my_room", {
        reconnectRoomId: info.roomId,
        locale: info.locale,
        mode: info.mode,
        open: !info.locked,
        guests: info.guests,
        ba: info.botAccounts,
        config,
      })
      .catch((e: unknown) => {
        throw joinError(e);
      });
    if (created.roomId === info.roomId) return created;
    created.leave().catch(() => {});
    throw new WordBombError("JOIN_FAILED", `room ${info.roomId} is coming back under another id, trying again`);
  }

  private async adopt(raw: Room<RawState>, rejoinWith: JoinOptions): Promise<GameRoom> {
    let restart: RestartInfo | null = null;
    const room = new GameRoom(raw, {
      ...this.ctx,
      restarting: (info) => {
        restart = info;
      },
    });
    this.open.set(room.id, room);
    room.once("room.closed", ({ reason }) => {
      if (this.open.get(room.id) === room) this.open.delete(room.id);
      if (!this.ctx.rejoin) return;
      if (reason === "restart" && restart) this.recover(restart, rejoinWith, 0);
      else if (reason === "disconnected") {
        this.later(REJOIN_DELAY, () => {
          this.join(room.id, rejoinWith).catch((e: unknown) => this.ctx.failed(e));
        });
      }
    });
    this.ctx.adopted(room);
    await room.settled();
    if (!room.isOpen) throw new WordBombError("JOIN_FAILED", `room ${room.id} closed right after joining`);
    return room;
  }
}
