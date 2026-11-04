import { Emitter } from "./emitter.js";
import { REALTIME_CLOSE, WordBombError } from "./errors.js";
import type { Session } from "./session.js";
import { num, record } from "./util.js";

const MIN_BACKOFF = 5000;
const MAX_BACKOFF = 120000;
const FAST_RETRY = 1000;
const REQUEST_TIMEOUT = 8000;

export interface RealtimeEvents {
  event: { e: string; d: unknown };
  up: void;
  down: { code: number; retryInMs: number };
  banned: void;
  replaced: void;
  closed: void;
}

interface Waiter {
  resolve(d: unknown): void;
  reject(e: WordBombError): void;
}

export class Realtime extends Emitter<RealtimeEvents> {
  private ws: WebSocket | null = null;
  private seq = 0;
  private readonly waiting = new Map<number, Waiter>();
  private backoff = MIN_BACKOFF;
  private fastRetryUsed = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    private readonly session: Session,
    private readonly clientId: string,
  ) {
    super();
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    if (this.closed) return;
    const url = `${this.session.target.ws2}/?token=${encodeURIComponent(this.session.token)}&cid=${encodeURIComponent(this.clientId)}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = MIN_BACKOFF;
      this.fastRetryUsed = false;
      this.emit("up", undefined);
    };
    ws.onmessage = (ev) => this.receive(ev.data);
    ws.onerror = () => {};
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.failAll(new WordBombError("REALTIME_DOWN", "the realtime connection closed before answering"));
      if (this.closed) return;
      if (ev.code === REALTIME_CLOSE.BANNED) {
        this.emit("banned", undefined);
        return;
      }
      if (ev.code === REALTIME_CLOSE.REPLACED || ev.code === REALTIME_CLOSE.REPLACED_ELSEWHERE) {
        this.emit("replaced", undefined);
        return;
      }
      const expired = ev.code === REALTIME_CLOSE.TOKEN_EXPIRED;
      let delay = this.backoff;
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF);
      if (expired && !this.fastRetryUsed) {
        this.fastRetryUsed = true;
        delay = FAST_RETRY;
      }
      this.emit("down", { code: ev.code, retryInMs: delay });
      this.retry = setTimeout(async () => {
        this.retry = null;
        if (expired) await this.session.refresh().catch(() => {});
        this.connect();
      }, delay);
    };
  }

  send(e: string, d: unknown): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify({ e, d }));
    return true;
  }

  request<T>(e: string, d: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new WordBombError("REALTIME_DOWN", "the realtime connection is down, try again in a moment"));
        return;
      }
      const i = ++this.seq;
      const timer = setTimeout(() => {
        if (this.waiting.delete(i)) reject(new WordBombError("TIMEOUT", `${e} got no answer`));
      }, REQUEST_TIMEOUT);
      this.waiting.set(i, {
        resolve: (reply) => {
          clearTimeout(timer);
          if (reply === null || reply === undefined) reject(new WordBombError("RATE_LIMITED", `${e} was rejected (rate limit or not allowed)`));
          else resolve(reply as T);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      ws.send(JSON.stringify({ e, d, i }));
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const ws = this.ws;
    this.ws = null;
    this.failAll(new WordBombError("REALTIME_DOWN", "the bot closed"));
    ws?.close();
    this.emit("closed", undefined);
  }

  private failAll(err: WordBombError): void {
    for (const w of this.waiting.values()) w.reject(err);
    this.waiting.clear();
  }

  private receive(raw: unknown): void {
    let frame: Record<string, unknown>;
    try {
      frame = record(JSON.parse(String(raw)));
    } catch {
      return;
    }
    if (typeof frame.r === "number") {
      const id = num(frame.r);
      const waiter = this.waiting.get(id);
      this.waiting.delete(id);
      waiter?.resolve(frame.d);
      return;
    }
    const e = typeof frame.e === "string" ? frame.e : "";
    if (!e) return;
    if (e === "ping") {
      this.send("pong", {});
      return;
    }
    this.emit("event", { e, d: frame.d });
  }
}
