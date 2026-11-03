import { WordBombError } from "./errors.js";

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function num(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export async function readBody(res: Response): Promise<{ data: unknown; text: string }> {
  const text = await res.text();
  if (!text) return { data: null, text };
  try {
    return { data: JSON.parse(text), text };
  } catch {
    return { data: text, text };
  }
}

export function errorText(data: unknown): string | null {
  const body = record(data);
  for (const key of ["error", "e", "message"]) {
    const value = body[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

export function httpError(what: string, res: Response, data: unknown, text: string): WordBombError {
  const html = text.trimStart().startsWith("<");
  const reason = errorText(data) ?? (html ? /<pre>([^<]*)<\/pre>/i.exec(text)?.[1] ?? res.statusText : text.slice(0, 200) || res.statusText);
  const message = `${what} ${res.status}: ${reason}`;
  if (res.status === 429) {
    const seconds = Number(res.headers.get("retry-after"));
    return new WordBombError("RATE_LIMITED", message, 429, Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined);
  }
  if (res.status === 401) return new WordBombError("AUTH_FAILED", message, 401);
  if (res.status === 403) return new WordBombError("FORBIDDEN", message, 403);
  if (res.status === 404) return new WordBombError("NOT_FOUND", message, 404);
  return new WordBombError("HTTP", message, res.status);
}

export function chatIdWith(myId: string, userId: string): string {
  return [myId, userId].sort().join("_");
}

export function isUserId(ref: string): boolean {
  return /^\d{10,}$/.test(ref) || ref.length > 16;
}
