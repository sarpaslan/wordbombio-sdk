import type { CommandDef, Commands } from "./commands.js";
import { wireMessage, type BotMessage, type BotReply, type WireMessage } from "./embeds.js";
import { WordBombError } from "./errors.js";
import { avatarUrl } from "./media.js";
import type { Realtime } from "./realtime.js";
import type { GameRoom } from "./room.js";
import type { Session } from "./session.js";
import type { Player } from "./types.js";
import { list, record, str } from "./util.js";

const REPLY_WINDOW = 14000;
const POST_LIMIT = 6;
const POST_WINDOW = 60000;
const SENT_RING = 50;

export type OptionValue = string | number | Player;

export interface CommandInteraction<R = GameRoom> {
  id: string;
  room: R;
  name: string;
  user: Player;
  options: Readonly<Record<string, OptionValue>>;
  string(name: string): string | null;
  number(name: string): number | null;
  player(name: string): Player | null;
  reply(message: BotReply): Promise<string>;
}

export interface ButtonInteraction<R = GameRoom> {
  id: string;
  room: R;
  messageId: string;
  customId: string;
  user: Player;
  reply(message: BotReply): Promise<string>;
  update(message: BotMessage): Promise<string>;
}

export interface InteractionRoom {
  readonly id: string;
  readonly isOpen: boolean;
  readonly players: Player[];
}

export interface InteractionSink<R> {
  command(interaction: CommandInteraction<R>): void;
  button(interaction: ButtonInteraction<R>): void;
}

export interface RoomChannel {
  sync(key: string): void;
  post(message: BotMessage): Promise<string>;
  close(): void;
}

interface Link {
  subscribe: boolean;
  sent: Map<string, Set<string>>;
  receive(e: string, frame: Record<string, unknown>): void;
}

function exactPlayer(all: Player[], ref: string): Player | null {
  const want = ref.trim().toLowerCase();
  if (!want) return null;
  return all.find((p) => p.id === ref || p.sessionId === ref) ?? all.find((p) => p.name.toLowerCase() === want) ?? null;
}

function coerce(type: string, choices: readonly string[] | undefined, value: unknown, players: Player[]): OptionValue | null {
  switch (type) {
    case "number": {
      const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value.trim()) : NaN;
      return Number.isFinite(n) ? n : null;
    }
    case "player":
      return typeof value === "string" ? exactPlayer(players, value) : null;
    case "choice": {
      if (typeof value !== "string") return null;
      const want = value.trim().toLowerCase();
      return choices?.find((c) => c.toLowerCase() === want) ?? null;
    }
    default:
      return typeof value === "string" ? value : typeof value === "number" ? String(value) : null;
  }
}

function readOptions(raw: unknown, def: CommandDef | null, players: Player[]): Record<string, OptionValue> {
  const out: Record<string, OptionValue> = {};
  if (!def) {
    for (const [name, value] of Object.entries(record(raw))) {
      if (typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) out[name] = value;
    }
    return out;
  }
  const defs = def.options ?? [];
  const positional = Array.isArray(raw) ? list(raw) : null;
  const named = record(raw);
  defs.forEach((option, index) => {
    const value = positional ? positional[index] : named[option.name];
    if (value === undefined || value === null || value === "") return;
    const parsed = coerce(option.type, option.choices, value, players);
    if (parsed !== null) out[option.name] = parsed;
  });
  return out;
}

function enabledButtons(wire: WireMessage): Set<string> {
  const ids = new Set<string>();
  for (const row of wire.e?.components ?? []) {
    for (const button of row.components) if (!button.disabled) ids.add(button.custom_id);
  }
  return ids;
}

function remember(sent: Map<string, Set<string>>, messageId: string, wire: WireMessage): void {
  sent.delete(messageId);
  const ids = enabledButtons(wire);
  if (!ids.size) return;
  sent.set(messageId, ids);
  if (sent.size > SENT_RING) {
    const oldest = sent.keys().next().value;
    if (oldest !== undefined) sent.delete(oldest);
  }
}

export class Interactions {
  private readonly links = new Map<string, Link>();

  constructor(
    private readonly realtime: Realtime | null,
    private readonly session: Session,
    private readonly commands: Commands,
  ) {}

  attach<R extends InteractionRoom>(room: R, sink: InteractionSink<R>, subscribe: boolean): RoomChannel {
    let key = "";
    const posts: number[] = [];
    const link: Link = { subscribe, sent: new Map(), receive: (e, frame) => this.deliver(room, sink, link.sent, e, frame) };
    const drop = () => {
      if (!key) return;
      if (this.links.get(key) === link) {
        this.links.delete(key);
        if (subscribe) this.realtime?.send("bot:unsub", { k: key });
      }
      link.sent.clear();
      key = "";
    };
    return {
      sync: (next) => {
        if (next === key) return;
        drop();
        key = next;
        if (!key) return;
        this.links.set(key, link);
        if (subscribe) this.realtime?.send("bot:sub", { k: key });
      },
      post: async (message) => {
        const wire = wireMessage(message, this.ownAvatar());
        if (!key) throw new WordBombError("NOT_IN_ROOM", `room ${room.id} has no bot channel yet, wait for room.ready`);
        const now = Date.now();
        while (posts.length) {
          const first = posts[0];
          if (first === undefined || now - first < POST_WINDOW) break;
          posts.shift();
        }
        const oldest = posts[0];
        if (posts.length >= POST_LIMIT && oldest !== undefined) {
          const wait = oldest + POST_WINDOW - now;
          throw new WordBombError("RATE_LIMITED", `at most ${POST_LIMIT} posts a minute per room, next one in ${Math.ceil(wait / 1000)}s`, undefined, wait);
        }
        posts.push(now);
        const sentKey = key;
        const messageId = await this.say({ k: sentKey, ...wire });
        if (key === sentKey) remember(link.sent, messageId, wire);
        return messageId;
      },
      close: drop,
    };
  }

  resubscribe(): void {
    for (const [key, link] of this.links) {
      if (link.subscribe) this.realtime?.send("bot:sub", { k: key });
    }
  }

  receive(e: string, d: unknown): void {
    const frame = record(d);
    this.links.get(str(frame.k))?.receive(e, frame);
  }

  private deliver<R extends InteractionRoom>(room: R, sink: InteractionSink<R>, sent: Map<string, Set<string>>, e: string, frame: Record<string, unknown>): void {
    const id = str(frame.i);
    const key = str(frame.k);
    const userId = str(frame.u);
    if (!id || !userId || userId === this.session.me.id || !room.isOpen) return;
    const players = room.players;
    const user = players.find((p) => p.id === userId);
    if (!user) return;
    if (e === "bot:cmd") {
      const name = str(frame.n);
      const def = this.commands.get(name);
      if (!name || (!def && this.commands.all.length)) return;
      const options = readOptions(frame.o, def, players);
      const answer = this.answerer(key, id, sent);
      sink.command({
        id,
        room,
        name,
        user,
        options,
        string: (n) => {
          const v = options[n];
          return typeof v === "string" ? v : null;
        },
        number: (n) => {
          const v = options[n];
          return typeof v === "number" ? v : null;
        },
        player: (n) => {
          const v = options[n];
          return v && typeof v === "object" ? v : null;
        },
        reply: (message) => answer(message, message.ephemeral === true ? { eph: true } : {}),
      });
      return;
    }
    if (e === "bot:btn") {
      const messageId = str(frame.m);
      const customId = str(frame.c);
      if (!messageId || !customId || !sent.get(messageId)?.has(customId)) return;
      const answer = this.answerer(key, id, sent);
      sink.button({
        id,
        room,
        messageId,
        customId,
        user,
        reply: (message) => answer(message, message.ephemeral === true ? { eph: true } : {}),
        update: (message) => answer(message, { up: messageId }),
      });
    }
  }

  private answerer(key: string, id: string, sent: Map<string, Set<string>>): (message: BotMessage, extra: { eph?: true; up?: string }) => Promise<string> {
    const deadline = Date.now() + REPLY_WINDOW;
    let answered = false;
    let sending = false;
    return async (message, extra) => {
      if (answered || sending) throw new WordBombError("INVALID", "this interaction already has its answer, each one gets exactly one reply or update");
      if (Date.now() > deadline) throw new WordBombError("TIMEOUT", "interactions must be answered within 14 seconds");
      const wire = wireMessage(message, this.ownAvatar());
      sending = true;
      try {
        const messageId = await this.say({ k: key, i: id, ...wire, ...extra });
        answered = true;
        if (extra.up) sent.delete(extra.up);
        remember(sent, messageId, wire);
        return messageId;
      } finally {
        sending = false;
      }
    };
  }

  private ownAvatar(): string | null {
    return avatarUrl(this.session.me.id, str(this.session.me.data.avatar));
  }

  private async say(frame: Record<string, unknown>): Promise<string> {
    const rt = this.realtime;
    if (!rt) throw new WordBombError("REALTIME_DOWN", "posts and replies need the realtime connection (connect with realtime: true)");
    const r = record(await rt.request("bot:say", frame));
    const m = str(r.m);
    if (m) return m;
    const reason = str(r.reason) || str(r.error);
    if (reason === "limited") throw new WordBombError("RATE_LIMITED", "the server rate limited this message");
    throw new WordBombError("FORBIDDEN", `the server refused this message${reason ? `: ${reason}` : ""}`);
  }
}
