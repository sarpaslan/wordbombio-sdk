import type { Room } from "@colyseus/sdk";
import { Autoplayer, type AutoplayOptions } from "./autoplay.js";
import type { BotMessage } from "./embeds.js";
import { Emitter } from "./emitter.js";
import { CLOSE, WordBombError } from "./errors.js";
import {
  feed,
  GAME_MESSAGES,
  pickPlayer,
  upperFor,
  type Eliminated,
  type FeedHost,
  type FeedSink,
  type GameEnd,
  type GameStart,
  type Hurt,
  type Miss,
  type MissReason,
  type PlayerEvent,
  type Solve,
} from "./feed.js";
import type { ButtonInteraction, CommandInteraction, InteractionSink, RoomChannel } from "./interactions.js";
import type { Player, RoomConfig } from "./types.js";
import { num, sleep, str } from "./util.js";

export interface SchemaMap<T> {
  get(key: string): T | undefined;
  forEach(fn: (value: T, key: string) => void): void;
}

export interface RawPlayer {
  auth_id?: string;
  username?: string;
  avatar?: string;
  heart?: number;
  eliminated?: boolean;
  spectating?: boolean;
  type?: number;
  bot?: boolean;
  lang?: string;
}

export interface RawState {
  players?: SchemaMap<RawPlayer>;
  host?: string;
  started?: boolean;
  currentPlayerSessionId?: string;
  letter?: string;
  turn?: number;
  time?: number;
  mode?: number;
  locale?: string;
  mlang?: boolean;
  locked?: boolean;
  title?: string;
  cs?: number;
  heart?: number;
  maxp?: number;
  guests?: boolean;
  ba?: boolean;
  sc?: number;
  teamMode?: boolean;
  bk?: string;
}

const CHAIN_MODE = 1;
const STARTS_WITH_CHAIN_STYLES = new Set([2, 3]);
const SUBMIT_TIMEOUT = 2500;
const SETTINGS_GAP = 300;
const LANGUAGE_TIMEOUT = 3000;
const BOT_ROLE = -1;

export type SubmitOutcome = { ok: true; word: string } | { ok: false; word: string; reason: MissReason };

export interface PlayOptions {
  cpm?: number;
}

export interface Turn {
  room: GameRoom;
  prompt: string;
  locale: string;
  masked: boolean;
  mode: number;
  match: "contains" | "startsWith";
  deadline: number;
  used: ReadonlySet<string>;
  timeLeftMs(): number;
  active(): boolean;
  matches(word: string): boolean;
  submit(word: string): Promise<SubmitOutcome>;
  play(word: string, opts?: PlayOptions): Promise<SubmitOutcome>;
}

export interface ChatMessage {
  room: GameRoom;
  from: Player | null;
  text: string;
  whisper: boolean;
  team: boolean;
  mentionsMe: boolean;
  reply(text: string): void;
  whisperBack(text: string): void;
}

export type LeaveReason = "left" | "closed" | "kicked" | "banned" | "joinTooFast" | "botsNotAllowed" | "disconnected" | "restart";

export interface RestartInfo {
  roomId: string;
  locale: string;
  mode: number;
  multiLanguage: boolean;
  locked: boolean;
  guests: boolean;
  botAccounts: boolean;
  chainStyle: number;
  scenario: number;
}

export interface RoomClosed {
  room: GameRoom;
  reason: LeaveReason;
  code: number;
}

export interface RoomEvents {
  "room.ready": { room: GameRoom };
  "room.state": { room: GameRoom };
  "room.closed": RoomClosed;
  "room.player.joined": PlayerEvent;
  "room.player.left": PlayerEvent;
  "room.host": PlayerEvent;
  "room.language": PlayerEvent;
  "room.settings": { room: GameRoom };
  "room.server": { room: GameRoom; text: string };
  "room.system": { room: GameRoom; text: string };
  "room.popup": { room: GameRoom; title: string; text: string };
  "room.afk": { room: GameRoom; seconds: number; extended: boolean };
  "chat.message": ChatMessage;
  "love.received": { room: GameRoom; from: Player | null };
  "game.start": GameStart;
  "game.turn": Turn;
  "game.solve": Solve;
  "game.miss": Miss;
  "game.hurt": Hurt;
  "game.eliminated": Eliminated;
  "game.end": GameEnd;
  "game.stop": { room: GameRoom };
  command: CommandInteraction;
  button: ButtonInteraction;
}

const ROOM_EVENT_SET = {
  "room.ready": true,
  "room.state": true,
  "room.closed": true,
  "room.player.joined": true,
  "room.player.left": true,
  "room.host": true,
  "room.language": true,
  "room.settings": true,
  "room.server": true,
  "room.system": true,
  "room.popup": true,
  "room.afk": true,
  "chat.message": true,
  "love.received": true,
  "game.start": true,
  "game.turn": true,
  "game.solve": true,
  "game.miss": true,
  "game.hurt": true,
  "game.eliminated": true,
  "game.end": true,
  "game.stop": true,
  command: true,
  button: true,
} satisfies Record<keyof RoomEvents, true>;

export const ROOM_EVENTS = Object.keys(ROOM_EVENT_SET) as Array<keyof RoomEvents>;

export interface RoomSettings {
  mode?: number;
  language?: string;
  multiLanguage?: boolean;
  locked?: boolean;
  hearts?: number;
  timer?: number;
  maxPlayers?: number;
  guests?: boolean;
  botAccounts?: boolean;
  [key: string]: unknown;
}

const SETTING_KEYS: Record<string, string> = { hearts: "heart", maxPlayers: "maxPlayer", multiLanguage: "multi_lang", botAccounts: "ba" };

interface ChatPayload { message?: unknown; id?: unknown; type?: unknown; priv?: unknown; team?: unknown }
interface ServerPayload { msg?: unknown }
interface PopupPayload { title?: unknown; message?: unknown }
interface LovePayload { from?: unknown }
interface AfkPayload { active?: unknown; seconds?: unknown; canExtend?: unknown }
interface RestartPayload { roomId?: unknown; locale?: unknown; mode?: unknown; mlang?: unknown; locked?: unknown; guests?: unknown; ba?: unknown; cs?: unknown; sc?: unknown }

interface Pending {
  word: string;
  key: string;
  resolve: (outcome: SubmitOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface GameRoomContext {
  myName(): string;
  keepAlive: boolean;
  channel(room: GameRoom, sink: InteractionSink<GameRoom>): RoomChannel;
  restarting(info: RestartInfo): void;
}

export class GameRoom extends Emitter<RoomEvents> {
  readonly used = new Set<string>();
  private readonly channel: RoomChannel;
  private readonly feedHost: FeedHost;
  private botKey = "";
  private known = new Map<string, Player>();
  private hostSession = "";
  private configKey = "";
  private turnKey = "";
  private turnSerial = 0;
  private pending: Pending | null = null;
  private ready = false;
  private open = true;
  private closing = false;
  private leaving = false;
  private restartPending = false;

  constructor(
    readonly raw: Room<RawState>,
    private readonly ctx: GameRoomContext,
  ) {
    super();
    this.feedHost = {
      used: this.used,
      me: () => this.sessionId,
      mode: () => this.mode,
      prompt: () => this.prompt,
      playing: () => {
        let playing = 0;
        this.state?.players?.forEach((p) => {
          if (num(p.heart) > 0) playing++;
        });
        return playing;
      },
      meIn: () => (this.me?.hearts ?? 0) > 0,
      lookup: (sid) => this.lookup(sid),
      upper: (word) => this.upper(word),
    };
    this.channel = ctx.channel(this, {
      command: (interaction) => this.emit("command", interaction),
      button: (interaction) => this.emit("button", interaction),
    });
    this.bind();
  }

  get id(): string {
    return this.raw.roomId;
  }

  get sessionId(): string {
    return this.raw.sessionId;
  }

  get isOpen(): boolean {
    return this.open;
  }

  get title(): string {
    return str(this.state?.title);
  }

  get mode(): number {
    return num(this.state?.mode);
  }

  get locale(): string {
    return str(this.state?.locale, "en-US");
  }

  get multiLanguage(): boolean {
    return this.state?.mlang === true;
  }

  get myLocale(): string {
    return this.me?.language ?? this.locale;
  }

  get config(): RoomConfig {
    const s = this.state;
    return {
      mode: num(s?.mode),
      language: this.locale,
      multiLanguage: s?.mlang === true,
      locked: s?.locked === true,
      hearts: num(s?.heart, 2),
      maxPlayers: num(s?.maxp, 16),
      guests: s?.guests !== false,
      botAccounts: s?.ba === true,
      scenario: num(s?.sc),
      teamMode: s?.teamMode === true,
      chainStyle: num(s?.mode) === CHAIN_MODE ? num(s?.cs) : 0,
      title: str(s?.title),
    };
  }

  get locked(): boolean {
    return this.state?.locked === true;
  }

  get started(): boolean {
    return this.state?.started === true;
  }

  get prompt(): string {
    return str(this.state?.letter);
  }

  get players(): Player[] {
    const out: Player[] = [];
    this.state?.players?.forEach((p, sid) => out.push(this.toPlayer(p, sid)));
    return out;
  }

  get me(): Player | null {
    return this.lookup(this.sessionId);
  }

  get host(): Player | null {
    const host = this.state?.host;
    return host ? this.lookup(host) : null;
  }

  get isHost(): boolean {
    return !!this.sessionId && this.state?.host === this.sessionId;
  }

  get currentPlayer(): Player | null {
    const sid = this.state?.currentPlayerSessionId;
    return this.started && sid ? this.lookup(sid) : null;
  }

  player(ref: string): Player {
    const hit = pickPlayer(this.players, ref);
    if (!hit) throw new WordBombError("NOT_FOUND", `nobody called "${ref}" in room ${this.id}`);
    return hit;
  }

  async post(message: BotMessage): Promise<string> {
    this.assertOpen();
    return this.channel.post(message);
  }

  settled(timeoutMs = 3000): Promise<void> {
    if (this.ready || !this.open) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, timeoutMs);
      const offReady = this.once("room.ready", done);
      const offClosed = this.once("room.closed", done);
      function done(): void {
        clearTimeout(timer);
        offReady();
        offClosed();
        resolve();
      }
    });
  }

  say(text: string): void {
    this.send("chat", { message: text.slice(0, 255) });
  }

  whisper(ref: string | Player, text: string): void {
    const p = this.resolve(ref);
    this.send("command", { command: "whisper", args: { to: p.sessionId, message: text.slice(0, 255) } });
  }

  love(ref: string | Player): void {
    this.send("love", { id: this.resolve(ref).id });
  }

  toggleSpectate(): void {
    this.send("spectate", {});
  }

  start(): void {
    this.send("start", {});
  }

  end(): void {
    this.send("end", {});
  }

  kick(ref: string | Player): void {
    this.send("kick", { id: this.resolve(ref).id, ban: false });
  }

  ban(ref: string | Player): void {
    this.send("kick", { id: this.resolve(ref).id, ban: true });
  }

  giveHost(ref: string | Player): void {
    this.send("host", { id: this.resolve(ref).id });
  }

  setTitle(title: string): void {
    this.send("command", { command: "title", args: { title } });
  }

  async settings(patch: RoomSettings): Promise<void> {
    const { mode, language, locked, ...rest } = patch;
    if (locked !== undefined) {
      this.send("settings", { locked });
      await sleep(SETTINGS_GAP);
    }
    const head: Record<string, unknown> = {};
    if (mode !== undefined) head.mode = mode;
    if (language !== undefined) head.language = language;
    if (Object.keys(head).length) {
      this.send("settings", head);
      await sleep(SETTINGS_GAP);
    }
    for (const [name, value] of Object.entries(rest)) {
      if (value === undefined) continue;
      this.send("settings", { key: SETTING_KEYS[name] ?? name, value });
      await sleep(SETTINGS_GAP);
    }
  }

  setLanguage(locale: string): Promise<boolean> {
    this.assertOpen();
    if (!this.multiLanguage) {
      return Promise.reject(new WordBombError("INVALID", "players only pick their own language in multi-language rooms; the host sets the room language with settings({ language })"));
    }
    if (this.myLocale === locale) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => finish(false), LANGUAGE_TIMEOUT);
      const offLanguage = this.on("room.language", ({ player }) => {
        if (player.isMe) finish(player.language === locale);
      });
      const offPopup = this.on("room.popup", ({ text }) => {
        if (text === "invalid_language") finish(false);
      });
      const offClosed = this.on("room.closed", () => finish(false));
      this.raw.send("lang-set", locale);
      function finish(ok: boolean): void {
        clearTimeout(timer);
        offLanguage();
        offPopup();
        offClosed();
        resolve(ok);
      }
    });
  }

  clearInput(): void {
    this.send("word", { t: "r", w: "" });
  }

  type(text: string, opts: PlayOptions = {}): Promise<boolean> {
    return this.typeFor(this.turnSerial, text, opts);
  }

  submit(word: string): Promise<SubmitOutcome> {
    return this.submitFor(this.turnSerial, word);
  }

  play(word: string, opts: PlayOptions = {}): Promise<SubmitOutcome> {
    return this.playFor(this.turnSerial, word, opts);
  }

  autoplay(opts: AutoplayOptions): Autoplayer {
    return new Autoplayer(this, opts);
  }

  async leave(): Promise<void> {
    if (!this.open) return;
    this.leaving = true;
    await this.raw.leave().catch(() => {});
  }

  private async typeFor(serial: number, text: string, opts: PlayOptions): Promise<boolean> {
    const delay = 60000 / Math.min(Math.max(opts.cpm ?? 300, 60), 3000);
    if (!this.open || serial !== this.turnSerial) return false;
    this.clearInput();
    for (const ch of text) {
      if (!this.open || serial !== this.turnSerial) return false;
      this.send("word", { t: "a", a: ch });
      await sleep(delay);
    }
    return this.open && serial === this.turnSerial;
  }

  private submitFor(serial: number, word: string): Promise<SubmitOutcome> {
    this.assertOpen();
    if (serial !== this.turnSerial) return Promise.resolve({ ok: false, word, reason: "turnOver" });
    if (this.pending) return Promise.resolve({ ok: false, word, reason: "busy" });
    return new Promise<SubmitOutcome>((resolve) => {
      const timer = setTimeout(() => this.settle({ ok: false, word, reason: "timeout" }), SUBMIT_TIMEOUT);
      this.pending = { word, key: this.upper(word), resolve, timer };
      this.raw.send("submit", { word });
    });
  }

  private async playFor(serial: number, word: string, opts: PlayOptions): Promise<SubmitOutcome> {
    if (!(await this.typeFor(serial, word, opts))) return { ok: false, word, reason: this.open ? "turnOver" : "left" };
    return this.submitFor(serial, word);
  }

  private get state(): RawState | undefined {
    return this.raw.state;
  }

  private send(type: string, payload: unknown): void {
    this.assertOpen();
    this.raw.send(type, payload);
  }

  private assertOpen(): void {
    if (!this.open) throw new WordBombError("NOT_IN_ROOM", `room ${this.id} is closed`);
  }

  private resolve(ref: string | Player): Player {
    return typeof ref === "string" ? this.player(ref) : ref;
  }

  private upper(word: string): string {
    return upperFor(word, this.myLocale);
  }

  private toPlayer(p: RawPlayer, sid: string): Player {
    const s = this.state;
    const id = str(p.auth_id);
    const hearts = num(p.heart);
    return {
      sessionId: sid,
      id,
      name: str(p.username, "Guest"),
      avatar: str(p.avatar),
      hearts,
      eliminated: p.eliminated === true,
      spectating: p.spectating === true,
      isHost: s?.host === sid,
      isMe: sid === this.sessionId,
      isTurn: s?.started === true && s.currentPlayerSessionId === sid,
      isGuest: id.length < 10,
      isBot: p.bot === true || p.type === BOT_ROLE,
      language: s?.mlang === true ? str(p.lang, this.locale) : this.locale,
    };
  }

  private lookup(sid: unknown): Player | null {
    const key = str(sid);
    if (!key) return null;
    const p = this.state?.players?.get(key);
    return p ? this.toPlayer(p, key) : this.known.get(key) ?? null;
  }

  private snapshot(): Map<string, Player> {
    const out = new Map<string, Player>();
    this.state?.players?.forEach((p, sid) => out.set(sid, this.toPlayer(p, sid)));
    return out;
  }

  private bind(): void {
    const r = this.raw;
    r.onStateChange(() => this.onState());
    r.onMessage("chat", (m: ChatPayload) => this.onChat(m));
    const sink = this.sink();
    for (const type of GAME_MESSAGES) r.onMessage(type, (m: unknown) => feed(type, m, this.feedHost, sink));
    r.onMessage("server-message", (m: ServerPayload) => {
      const text = str(m.msg);
      if (!text || text.startsWith("/")) return;
      if (/No active players remain/i.test(text)) this.closing = true;
      this.emit("room.server", { room: this, text });
    });
    r.onMessage("popup", (m: PopupPayload) => this.emit("room.popup", { room: this, title: str(m.title), text: str(m.message) }));
    r.onMessage("love", (m: LovePayload) => this.emit("love.received", { room: this, from: this.lookup(m.from) }));
    r.onMessage("afk-warning", (m: AfkPayload) => {
      if (m.active === false) return;
      const extended = this.ctx.keepAlive && m.canExtend === true;
      if (extended) r.send("afk-keepalive", {});
      this.emit("room.afk", { room: this, seconds: num(m.seconds), extended });
    });
    r.onMessage("reconnect-data", (m: RestartPayload) => {
      const multiLanguage = m.mlang === true;
      this.restartPending = true;
      this.ctx.restarting({
        roomId: str(m.roomId, this.id),
        locale: multiLanguage ? this.myLocale : str(m.locale, this.locale),
        mode: num(m.mode, this.mode),
        multiLanguage,
        locked: m.locked === true,
        guests: m.guests !== false,
        botAccounts: m.ba === true,
        chainStyle: num(m.cs),
        scenario: num(m.sc),
      });
    });
    r.onMessage("*", () => {});
    r.onLeave((code: number) => this.onLeave(code));
  }

  private sink(): FeedSink {
    return {
      start: (e) => this.emit("game.start", { room: this, ...e }),
      stop: () => {
        this.endTurn();
        this.emit("game.stop", { room: this });
      },
      solve: (e) => {
        if (e.mine) this.settle({ ok: true, word: this.pending?.word ?? e.word }, e.word);
        this.emit("game.solve", { room: this, ...e });
      },
      miss: (e) => {
        if (e.mine) this.settle({ ok: false, word: this.pending?.word ?? e.word, reason: e.reason }, e.word);
        this.emit("game.miss", { room: this, ...e });
      },
      hurt: (e) => this.emit("game.hurt", { room: this, ...e }),
      eliminated: (e) => {
        if (e.mine) this.endTurn();
        this.emit("game.eliminated", { room: this, ...e });
      },
      end: (e) => this.emit("game.end", { room: this, ...e }),
    };
  }

  private onState(): void {
    const s = this.state;
    if (!s?.players) return;
    if (!this.ready && !s.players.get(this.sessionId)) return;
    const key = str(s.bk);
    if (key !== this.botKey) {
      this.botKey = key;
      this.channel.sync(key);
    }
    if (!this.ready) {
      this.ready = true;
      this.known = this.snapshot();
      this.hostSession = str(s.host);
      this.configKey = JSON.stringify(this.config);
      this.emit("room.ready", { room: this });
    } else {
      this.diff();
    }
    this.emit("room.state", { room: this });
    this.checkTurn();
  }

  private diff(): void {
    const next = this.snapshot();
    const before = this.known;
    this.known = next;
    const config = JSON.stringify(this.config);
    if (config !== this.configKey) {
      this.configKey = config;
      this.emit("room.settings", { room: this });
    }
    for (const [sid, player] of next) {
      const was = before.get(sid);
      if (!was) {
        if (!player.isMe) this.emit("room.player.joined", { room: this, player });
      } else if (was.language !== player.language) {
        this.emit("room.language", { room: this, player });
      }
    }
    for (const [sid, player] of before) {
      if (!next.has(sid) && !player.isMe) this.emit("room.player.left", { room: this, player });
    }
    const host = str(this.state?.host);
    if (host && host !== this.hostSession) {
      this.hostSession = host;
      const player = next.get(host);
      if (player) this.emit("room.host", { room: this, player });
    }
  }

  private checkTurn(): void {
    const s = this.state;
    if (!s?.started || s.currentPlayerSessionId !== this.sessionId) {
      if (this.turnKey) this.endTurn();
      return;
    }
    const key = `${num(s.turn)}:${str(s.letter)}`;
    if (key === this.turnKey) return;
    this.turnKey = key;
    const serial = ++this.turnSerial;
    const prompt = str(s.letter);
    const mode = num(s.mode);
    const match = mode === CHAIN_MODE && STARTS_WITH_CHAIN_STYLES.has(num(s.cs)) ? "startsWith" : "contains";
    const deadline = Date.now() + Math.max(0, num(s.time)) * 1000;
    const upperPrompt = this.upper(prompt);
    const turn: Turn = {
      room: this,
      prompt,
      locale: this.myLocale,
      masked: prompt.startsWith("#"),
      mode,
      match,
      deadline,
      used: this.used,
      timeLeftMs: () => Math.max(0, deadline - Date.now()),
      active: () => this.open && serial === this.turnSerial,
      matches: (word) => {
        const w = this.upper(word);
        return !this.used.has(w) && (match === "startsWith" ? w.startsWith(upperPrompt) : w.includes(upperPrompt));
      },
      submit: (word) => this.submitFor(serial, word),
      play: (word, opts) => this.playFor(serial, word, opts ?? {}),
    };
    this.emit("game.turn", turn);
  }

  private endTurn(): void {
    this.turnKey = "";
    this.turnSerial++;
  }

  private settle(outcome: SubmitOutcome, serverWord?: string): void {
    const p = this.pending;
    if (!p) return;
    if (serverWord !== undefined && this.upper(serverWord) !== p.key) return;
    this.pending = null;
    clearTimeout(p.timer);
    p.resolve(outcome);
  }

  private onChat(m: ChatPayload): void {
    const text = m.message;
    if (typeof text !== "string") return;
    if (m.type === "system") {
      this.emit("room.system", { room: this, text });
      return;
    }
    if (m.type) return;
    const from = this.lookup(m.id);
    if (from?.isMe) return;
    const name = this.ctx.myName().toLowerCase();
    const whisper = m.priv === true;
    this.emit("chat.message", {
      room: this,
      from,
      text,
      whisper,
      team: m.team === true,
      mentionsMe: whisper || (!!name && text.toLowerCase().includes(name)),
      reply: (reply) => this.say(reply),
      whisperBack: (reply) => {
        if (from) this.whisper(from, reply);
      },
    });
  }

  private onLeave(code: number): void {
    this.open = false;
    this.botKey = "";
    this.channel.close();
    this.endTurn();
    this.settle({ ok: false, word: this.pending?.word ?? "", reason: "left" });
    let reason: LeaveReason = "disconnected";
    if (this.leaving) reason = "left";
    else if (code === CLOSE.KICKED) reason = this.closing ? "closed" : "kicked";
    else if (code === CLOSE.BANNED) reason = "banned";
    else if (code === CLOSE.JOIN_TOO_FAST) reason = "joinTooFast";
    else if (code === CLOSE.BOTS_NOT_ALLOWED) reason = "botsNotAllowed";
    else if (this.restartPending) reason = "restart";
    else if (code === CLOSE.NORMAL || code === 1000) reason = "closed";
    this.emit("room.closed", { room: this, reason, code });
  }
}
