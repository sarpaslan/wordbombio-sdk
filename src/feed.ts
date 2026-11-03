import type { GameRoom } from "./room.js";
import type { Player } from "./types.js";
import { list, num, record, str } from "./util.js";

export type MissReason =
  | "wrong"
  | "used"
  | "tooShort"
  | "noPrompt"
  | "notAWord"
  | "selfSolve"
  | "wrongStart"
  | "notInCategory"
  | "bannedLetter"
  | "wrongLength"
  | "wrongEnd"
  | "timeout"
  | "turnOver"
  | "busy"
  | "left";

const MISS_REASONS: Record<number, MissReason> = {
  0: "wrong",
  2: "used",
  3: "tooShort",
  4: "noPrompt",
  5: "notAWord",
  6: "selfSolve",
  7: "wrongStart",
  8: "notInCategory",
  9: "bannedLetter",
  10: "wrongLength",
  11: "wrongEnd",
};

export interface PlayerEvent<R = GameRoom> {
  room: R;
  player: Player;
}

export interface Solve<R = GameRoom> {
  room: R;
  player: Player | null;
  word: string;
  mine: boolean;
}

export interface Miss<R = GameRoom> {
  room: R;
  player: Player | null;
  word: string;
  reason: MissReason;
  mine: boolean;
}

export interface Hurt<R = GameRoom> {
  room: R;
  player: Player | null;
  hearts: number;
  prompt: string;
  mine: boolean;
}

export interface Eliminated<R = GameRoom> {
  room: R;
  player: Player | null;
  mine: boolean;
}

export interface GameStart<R = GameRoom> {
  room: R;
  mode: number;
  playing: number;
  meIn: boolean;
}

export interface PodiumEntry {
  place: number;
  name: string;
  sessionId: string;
}

export interface GameEnd<R = GameRoom> {
  room: R;
  podium: PodiumEntry[];
  myPlace: number | null;
}

export interface FeedHost {
  readonly used: Set<string>;
  me(): string;
  mode(): number;
  prompt(): string;
  playing(): number;
  meIn(): boolean;
  lookup(sessionId: unknown): Player | null;
  upper(word: string): string;
}

export interface FeedSink {
  start(e: Omit<GameStart, "room">): void;
  stop(): void;
  solve(e: Omit<Solve, "room">): void;
  miss(e: Omit<Miss, "room">): void;
  hurt(e: Omit<Hurt, "room">): void;
  eliminated(e: Omit<Eliminated, "room">): void;
  end(e: Omit<GameEnd, "room">): void;
}

export type FeedEvent =
  | { t: "start" }
  | { t: "stop" }
  | { t: "solve"; s: unknown; word: string }
  | { t: "miss"; s: unknown; result: unknown; word: string }
  | { t: "hurt"; s: unknown; hearts: number; prompt: string | null }
  | { t: "eliminated"; s: unknown }
  | { t: "end"; rows: PodiumEntry[] };

export const GAME_MESSAGES = ["correct", "wrong", "hurt", "eliminated", "start", "stop", "winner"] as const;

export type GameMessage = (typeof GAME_MESSAGES)[number];

export function upperFor(word: string, locale: string): string {
  try {
    return word.toLocaleUpperCase(locale);
  } catch {
    return word.toUpperCase();
  }
}

export function pickPlayer(all: Player[], ref: string): Player | null {
  const want = ref.trim().toLowerCase();
  if (!want) return null;
  return (
    all.find((p) => p.sessionId.toLowerCase() === want || p.id.toLowerCase() === want || p.name.toLowerCase() === want) ??
    all.find((p) => p.name.toLowerCase().startsWith(want)) ??
    null
  );
}

const REASON_NAMES = new Map<string, MissReason>(Object.values(MISS_REASONS).map((r) => [r, r]));

function missReason(result: unknown): MissReason {
  const code = typeof result === "number" ? result : typeof result === "string" && result !== "" ? Number(result) : -1;
  if (Number.isFinite(code)) return MISS_REASONS[code] ?? "wrong";
  return (typeof result === "string" && REASON_NAMES.get(result)) || "wrong";
}

export function dispatch(event: FeedEvent, host: FeedHost, sink: FeedSink): void {
  const me = host.me();
  const isMine = (sessionId: unknown) => !!me && str(sessionId) === me;
  switch (event.t) {
    case "start":
      host.used.clear();
      sink.start({ mode: host.mode(), playing: host.playing(), meIn: host.meIn() });
      return;
    case "stop":
      host.used.clear();
      sink.stop();
      return;
    case "solve": {
      const word = host.upper(event.word);
      if (word) host.used.add(word);
      sink.solve({ player: host.lookup(event.s), word, mine: isMine(event.s) });
      return;
    }
    case "miss": {
      const reason = missReason(event.result);
      if (reason === "used" && event.word) host.used.add(host.upper(event.word));
      sink.miss({ player: host.lookup(event.s), word: event.word, reason, mine: isMine(event.s) });
      return;
    }
    case "hurt":
      sink.hurt({ player: host.lookup(event.s), hearts: event.hearts, prompt: event.prompt ?? host.prompt(), mine: isMine(event.s) });
      return;
    case "eliminated":
      sink.eliminated({ player: host.lookup(event.s), mine: isMine(event.s) });
      return;
    case "end": {
      let myPlace: number | null = null;
      for (const row of event.rows) if (me && row.sessionId === me) myPlace = row.place;
      const podium = event.rows.filter((row) => row.place > 0).sort((a, b) => a.place - b.place);
      sink.end({ podium, myPlace });
      return;
    }
  }
}

function podiumRows(payload: Record<string, unknown>): PodiumEntry[] {
  return list(payload.stats).map((entry) => {
    const row = record(entry);
    const player = record(row.player);
    return { place: num(row.place), name: str(player.name), sessionId: str(player.session_id) };
  });
}

export function feed(type: GameMessage, payload: unknown, host: FeedHost, sink: FeedSink): void {
  const m = record(payload);
  switch (type) {
    case "correct":
      dispatch({ t: "solve", s: m.id, word: str(m.word) }, host, sink);
      return;
    case "wrong":
      dispatch({ t: "miss", s: m.id, result: num(m.result, -1), word: str(m.word) }, host, sink);
      return;
    case "hurt":
      dispatch({ t: "hurt", s: m.id, hearts: num(m.heart), prompt: typeof m.prompt === "string" ? m.prompt : null }, host, sink);
      return;
    case "eliminated":
      dispatch({ t: "eliminated", s: m.id }, host, sink);
      return;
    case "start":
      dispatch({ t: "start" }, host, sink);
      return;
    case "stop":
      dispatch({ t: "stop" }, host, sink);
      return;
    case "winner":
      dispatch({ t: "end", rows: podiumRows(m) }, host, sink);
      return;
  }
}
