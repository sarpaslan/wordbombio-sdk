export type ErrorCode =
  | "INVALID"
  | "AUTH_FAILED"
  | "BANNED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "HTTP"
  | "TIMEOUT"
  | "REALTIME_DOWN"
  | "NOT_IN_ROOM"
  | "ROOM_NOT_FOUND"
  | "JOIN_FAILED"
  | "JOIN_TOO_FAST"
  | "BOTS_NOT_ALLOWED"
  | "ALREADY_IN_ROOM"
  | "BOT_ROOM_LIMIT"
  | "APP_NO_ROOMS"
  | "BOTS_DISABLED"
  | "KICKED"
  | "LINK_DROPPED";

export class WordBombError extends Error {
  override readonly name = "WordBombError";

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export function invalid(path: string, rule: string): WordBombError {
  return new WordBombError("INVALID", `${path} ${rule}`);
}

export const CLOSE = {
  NORMAL: 4000,
  BANNED: 4201,
  PLAYING: 4202,
  KICKED: 4203,
  JOIN_TOO_FAST: 4205,
  BOTS_NOT_ALLOWED: 4207,
  BOT_ROOM_LIMIT: 4208,
  APP_NO_ROOMS: 4209,
  ROOM_NOT_FOUND: 4212,
  AUTH_FAILED: 4215,
} as const;

export const REALTIME_CLOSE = {
  REPLACED: 4001,
  REPLACED_ELSEWHERE: 4009,
  BANNED: 4201,
  TOKEN_EXPIRED: 4401,
} as const;

export function readError(e: unknown): { code: number; message: string } {
  if (e && typeof e === "object") {
    const code = "code" in e && typeof e.code === "number" ? e.code : 0;
    const message = "message" in e && typeof e.message === "string" ? e.message : String(e);
    return { code, message };
  }
  return { code: 0, message: String(e) };
}

export function joinError(e: unknown): WordBombError {
  if (e instanceof WordBombError) return e;
  const { code, message } = readError(e);
  switch (code) {
    case CLOSE.BANNED:
      return new WordBombError("BANNED", message || "banned from this room", code);
    case CLOSE.KICKED:
      return new WordBombError("KICKED", message || "kicked from this room", code);
    case CLOSE.JOIN_TOO_FAST:
      return new WordBombError("JOIN_TOO_FAST", message || "joined too many rooms too fast", code);
    case CLOSE.BOTS_NOT_ALLOWED:
      return new WordBombError("BOTS_NOT_ALLOWED", message || "this room does not allow bot accounts", code);
    case CLOSE.PLAYING:
      return new WordBombError("ALREADY_IN_ROOM", message || "this bot is already in that room", code);
    case CLOSE.BOT_ROOM_LIMIT:
      return new WordBombError("BOT_ROOM_LIMIT", message || "this bot is in as many rooms as it may be at once", code);
    case CLOSE.APP_NO_ROOMS:
      return new WordBombError("APP_NO_ROOMS", message || "applications never join rooms, they get them from bot.apps", code);
    case CLOSE.ROOM_NOT_FOUND:
      return new WordBombError("ROOM_NOT_FOUND", message || "room not found", code);
    case CLOSE.AUTH_FAILED:
      return new WordBombError("AUTH_FAILED", message || "room rejected the bot token", code);
    default:
      return new WordBombError("JOIN_FAILED", message || "could not join the room", code || undefined);
  }
}
