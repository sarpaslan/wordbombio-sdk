import type { BotMessage } from "./embeds.js";
import { Emitter } from "./emitter.js";
import { WordBombError } from "./errors.js";
import {
  dispatch,
  pickPlayer,
  upperFor,
  type Eliminated,
  type FeedEvent,
  type FeedHost,
  type FeedSink,
  type GameEnd,
  type GameStart,
  type Hurt,
  type Miss,
  type PlayerEvent,
  type PodiumEntry,
  type Solve,
} from "./feed.js";
import type { ButtonInteraction, CommandInteraction, InteractionSink, Interactions, RoomChannel } from "./interactions.js";
import type { Realtime } from "./realtime.js";
import type { GameRoom } from "./room.js";
import type { Player } from "./types.js";
import { list, num, record, str } from "./util.js";

export type AnyRoom = GameRoom | AppRoom;

export interface AppRoomEvents {
  "room.ready": { room: AppRoom };
  "room.state": { room: AppRoom };
  "room.close": { room: AppRoom };
  "room.player.joined": PlayerEvent<AppRoom>;
  "room.player.left": PlayerEvent<AppRoom>;
  "game.start": GameStart<AppRoom>;
  "game.solve": Solve<AppRoom>;
  "game.miss": Miss<AppRoom>;
  "game.hurt": Hurt<AppRoom>;
  "game.eliminated": Eliminated<AppRoom>;
  "game.end": GameEnd<AppRoom>;
  "game.stop": { room: AppRoom };
  command: CommandInteraction<AppRoom>;
  button: ButtonInteraction<AppRoom>;
}

const APP_ROOM_EVENT_SET = {
  "room.ready": true,
  "room.state": true,
  "room.close": true,
  "room.player.joined": true,
  "room.player.left": true,
  "game.start": true,
  "game.solve": true,
  "game.miss": true,
  "game.hurt": true,
  "game.eliminated": true,
  "game.end": true,
  "game.stop": true,
  command: true,
  button: true,
} satisfies Record<keyof AppRoomEvents, true>;

export const APP_ROOM_EVENTS = Object.keys(APP_ROOM_EVENT_SET) as Array<keyof AppRoomEvents>;

export interface AppEvents extends AppRoomEvents {
  "room.open": { room: AppRoom };
}

interface Seat {
  sid: string;
  id: string;
  name: string;
  bot: boolean;
  spectating: boolean;
  hearts: number;
  eliminated: boolean;
}

interface AppRoomControls {
  apply(lines: string[]): void;
  close(): void;
}

interface AppRoomContext {
  channel(room: AppRoom, sink: InteractionSink<AppRoom>): RoomChannel;
  bind(room: AppRoom, controls: AppRoomControls): void;
}

function fields(line: string, count: number): string[] {
  const out: string[] = [];
  let from = 2;
  for (let i = 1; i < count; i++) {
    const at = line.indexOf(":", from);
    if (at < 0) break;
    out.push(line.slice(from, at));
    from = at + 1;
  }
  out.push(from <= line.length ? line.slice(from) : "");
  return out;
}

export class AppRoom extends Emitter<AppRoomEvents> {
  readonly used = new Set<string>();
  private readonly seats = new Map<string, Seat>();
  private readonly gone = new Map<string, Player>();
  private readonly channel: RoomChannel;
  private readonly feedHost: FeedHost;
  private readonly sink: FeedSink;
  private modeId = 0;
  private lang = "en-US";
  private running = false;
  private turnSession = "";
  private letters = "";
  private ready = false;
  private open = true;

  constructor(
    readonly id: string,
    ctx: AppRoomContext,
  ) {
    super();
    this.feedHost = {
      used: this.used,
      me: () => "",
      mode: () => this.modeId,
      prompt: () => this.letters,
      playing: () => {
        let playing = 0;
        for (const seat of this.seats.values()) if (seat.hearts > 0) playing++;
        return playing;
      },
      meIn: () => false,
      lookup: (sid) => this.lookup(str(sid)),
      upper: (word) => upperFor(word, this.lang),
    };
    this.sink = {
      start: (e) => this.emit("game.start", { room: this, ...e }),
      stop: () => {
        this.running = false;
        this.turnSession = "";
        this.emit("game.stop", { room: this });
      },
      solve: (e) => this.emit("game.solve", { room: this, ...e }),
      miss: (e) => this.emit("game.miss", { room: this, ...e }),
      hurt: (e) => this.emit("game.hurt", { room: this, ...e }),
      eliminated: (e) => this.emit("game.eliminated", { room: this, ...e }),
      end: (e) => this.emit("game.end", { room: this, ...e }),
    };
    this.channel = ctx.channel(this, {
      command: (interaction) => this.emit("command", interaction),
      button: (interaction) => this.emit("button", interaction),
    });
    this.channel.sync(id);
    ctx.bind(this, { apply: (lines) => this.apply(lines), close: () => this.close() });
  }

  get isOpen(): boolean {
    return this.open;
  }

  get mode(): number {
    return this.modeId;
  }

  get locale(): string {
    return this.lang;
  }

  get started(): boolean {
    return this.running;
  }

  get prompt(): string {
    return this.letters;
  }

  get players(): Player[] {
    return [...this.seats.values()].map((seat) => this.toPlayer(seat));
  }

  get currentPlayer(): Player | null {
    return this.running && this.turnSession ? this.lookup(this.turnSession) : null;
  }

  player(ref: string): Player {
    const hit = pickPlayer(this.players, ref);
    if (!hit) throw new WordBombError("NOT_FOUND", `nobody called "${ref}" in app room ${this.id}`);
    return hit;
  }

  async post(message: BotMessage): Promise<string> {
    if (!this.open) throw new WordBombError("NOT_IN_ROOM", `app room ${this.id} is closed`);
    return this.channel.post(message);
  }

  private toPlayer(seat: Seat): Player {
    return {
      sessionId: seat.sid,
      id: seat.id,
      name: seat.name,
      avatar: "",
      hearts: seat.hearts,
      eliminated: seat.eliminated,
      spectating: seat.spectating,
      isHost: false,
      isMe: false,
      isTurn: this.running && this.turnSession === seat.sid,
      isGuest: seat.id.length < 10,
      isBot: seat.bot,
      language: this.lang,
    };
  }

  private lookup(sid: string): Player | null {
    const seat = this.seats.get(sid);
    return seat ? this.toPlayer(seat) : this.gone.get(sid) ?? null;
  }

  private feed(event: FeedEvent): void {
    dispatch(event, this.feedHost, this.sink);
  }

  private close(): void {
    if (!this.open) return;
    this.open = false;
    this.channel.close();
    this.emit("room.close", { room: this });
  }

  private apply(lines: string[]): void {
    if (!this.open) return;
    let snapshot = false;
    let head = false;
    let changed = false;
    for (const line of lines) {
      const tag = line[0];
      if (!tag || (line.length > 1 && line[1] !== ":")) continue;
      if (tag !== "j") snapshot = false;
      switch (tag) {
        case "S": {
          const [mode = "", locale = "", started = ""] = fields(line, 3);
          this.modeId = num(mode);
          this.lang = locale || this.lang;
          this.running = started === "1";
          this.seats.clear();
          this.gone.clear();
          this.turnSession = "";
          snapshot = true;
          head = true;
          break;
        }
        case "j": {
          const [sid = "", id = "", bot = "", spec = "", hearts = "", name = ""] = fields(line, 6);
          if (!sid) break;
          const fresh = !this.seats.has(sid);
          const seat: Seat = { sid, id, name: name || "Guest", bot: bot === "1", spectating: spec === "1", hearts: num(hearts), eliminated: false };
          this.seats.set(sid, seat);
          this.gone.delete(sid);
          if (fresh && !snapshot) this.emit("room.player.joined", { room: this, player: this.toPlayer(seat) });
          break;
        }
        case "l": {
          const [sid = ""] = fields(line, 1);
          const seat = this.seats.get(sid);
          if (!seat) break;
          const player = this.toPlayer(seat);
          this.seats.delete(sid);
          this.gone.set(sid, player);
          if (this.gone.size > 64) {
            const oldest = this.gone.keys().next().value;
            if (oldest !== undefined) this.gone.delete(oldest);
          }
          this.emit("room.player.left", { room: this, player });
          break;
        }
        case "g":
          this.running = true;
          for (const seat of this.seats.values()) seat.eliminated = false;
          this.feed({ t: "start" });
          break;
        case "G": {
          const [winners = ""] = fields(line, 1);
          const rows: PodiumEntry[] = [];
          for (const sid of winners.split(",")) {
            if (sid) rows.push({ place: 1, name: this.lookup(sid)?.name ?? "", sessionId: sid });
          }
          this.feed({ t: "end", rows });
          this.feed({ t: "stop" });
          break;
        }
        case "t": {
          const [sid = "", prompt = ""] = fields(line, 2);
          this.running = true;
          this.turnSession = sid;
          this.letters = prompt;
          break;
        }
        case "c": {
          const [sid = "", word = ""] = fields(line, 2);
          this.feed({ t: "solve", s: sid, word });
          break;
        }
        case "x": {
          const [sid = "", result = "", word = ""] = fields(line, 3);
          this.feed({ t: "miss", s: sid, result, word });
          break;
        }
        case "h": {
          const [sid = "", value = ""] = fields(line, 2);
          const hearts = num(value);
          const seat = this.seats.get(sid);
          if (seat) seat.hearts = hearts;
          this.feed({ t: "hurt", s: sid, hearts, prompt: null });
          break;
        }
        case "e": {
          const [sid = ""] = fields(line, 1);
          const seat = this.seats.get(sid);
          if (seat) {
            seat.eliminated = true;
            seat.hearts = 0;
          }
          this.feed({ t: "eliminated", s: sid });
          break;
        }
        default:
          continue;
      }
      changed = true;
    }
    if (!this.ready && (head || this.seats.size)) {
      this.ready = true;
      this.emit("room.ready", { room: this });
    }
    if (changed && this.ready) this.emit("room.state", { room: this });
  }
}

const REANNOUNCE_WAIT = 10000;

export class Apps extends Emitter<AppEvents> {
  private readonly open = new Map<string, { room: AppRoom; controls: AppRoomControls }>();
  private readonly unconfirmed = new Set<string>();
  private recheckTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly interactions: Interactions,
    realtime: Realtime | null,
  ) {
    super();
    realtime?.on("event", ({ e, d }) => {
      if (e === "app:ev") this.onEvents(d);
      else if (e === "app:room") this.onRoom(d);
    });
    realtime?.on("up", () => this.recheck());
    realtime?.on("closed", () => this.closeAll());
  }

  get all(): AppRoom[] {
    return [...this.open.values()].map((entry) => entry.room);
  }

  get(id: string): AppRoom | null {
    return this.open.get(id)?.room ?? null;
  }

  private recheck(): void {
    this.stopRecheck();
    for (const key of this.open.keys()) this.unconfirmed.add(key);
    if (!this.unconfirmed.size) return;
    this.recheckTimer = setTimeout(() => {
      this.recheckTimer = null;
      for (const key of [...this.unconfirmed]) this.open.get(key)?.controls.close();
      this.unconfirmed.clear();
    }, REANNOUNCE_WAIT);
  }

  private stopRecheck(): void {
    if (this.recheckTimer) clearTimeout(this.recheckTimer);
    this.recheckTimer = null;
    this.unconfirmed.clear();
  }

  private closeAll(): void {
    this.stopRecheck();
    for (const { controls } of [...this.open.values()]) controls.close();
  }

  private onRoom(d: unknown): void {
    const frame = record(d);
    const key = str(frame.k);
    if (!key) return;
    this.unconfirmed.delete(key);
    if (frame.open === false || frame.open === 0) this.open.get(key)?.controls.close();
    else this.ensure(key);
  }

  private onEvents(d: unknown): void {
    let key: string;
    let lines: string[];
    if (typeof d === "string") {
      const cut = d.indexOf("\n");
      key = cut < 0 ? d : d.slice(0, cut);
      lines = cut < 0 ? [] : d.slice(cut + 1).split("\n");
    } else {
      const frame = record(d);
      key = str(frame.k);
      const ev = frame.ev;
      lines = typeof ev === "string" ? ev.split("\n") : list(ev).map((line) => str(line));
    }
    if (!key || !lines.length) return;
    this.unconfirmed.delete(key);
    this.ensure(key).apply(lines);
  }

  private ensure(key: string): AppRoomControls {
    const existing = this.open.get(key);
    if (existing) return existing.controls;
    const holder: { controls?: AppRoomControls } = {};
    const room = new AppRoom(key, {
      channel: (r, sink) => this.interactions.attach(r, sink, false),
      bind: (_, controls) => {
        holder.controls = controls;
      },
    });
    const bound = holder.controls;
    if (!bound) throw new WordBombError("INVALID", "app room failed to bind");
    this.open.set(key, { room, controls: bound });
    const relay = this.emit.bind(this) as (event: keyof AppEvents, payload: unknown) => void;
    for (const name of APP_ROOM_EVENTS) room.on(name, (payload) => relay(name, payload));
    room.once("room.close", () => {
      if (this.open.get(key)?.room === room) this.open.delete(key);
    });
    this.emit("room.open", { room });
    return bound;
  }
}
