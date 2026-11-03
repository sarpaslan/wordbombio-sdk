import { WordBombError } from "./errors.js";
import type { Target } from "./targets.js";
import { errorText, httpError, readBody, record, str } from "./util.js";

const KEY_PATTERN = /^wbb_(\d{17,20})_[A-Za-z0-9_-]{20,}$/;
const REFRESH_MS = 100 * 60 * 1000;
const RETRY_MS = 30 * 1000;

export interface Me {
  id: string;
  name: string;
  data: Record<string, unknown>;
}

export type BotKind = "bot" | "app";

function claims(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) return {};
  try {
    return record(JSON.parse(Buffer.from(part, "base64url").toString("utf8")));
  } catch {
    return {};
  }
}

export class Session {
  token = "";
  kind: BotKind = "bot";
  readonly me: Me;
  private readonly key: string;
  private readonly listeners = new Set<(token: string) => void>();
  private inflight: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    readonly target: Target,
    key: string,
    private readonly onError: (e: Error) => void,
    private readonly onBanned: () => void,
  ) {
    const trimmed = key.trim();
    const match = KEY_PATTERN.exec(trimmed);
    if (!match?.[1]) throw new WordBombError("INVALID", "a bot key looks like wbb_<bot id>_<secret>. Create one at https://wordbomb.io/bots");
    this.key = trimmed;
    this.me = { id: match[1], name: "", data: {} };
  }

  onToken(fn: (token: string) => void): void {
    this.listeners.add(fn);
  }

  refresh(): Promise<void> {
    if (!this.inflight) {
      this.inflight = this.exchange().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async exchange(): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${this.target.game}/auth/bot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: this.key }),
      });
    } catch (e) {
      throw new WordBombError("HTTP", `could not reach ${this.target.game}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const { data, text } = await readBody(res);
    const body = record(data);
    if (body.banned === true) throw new WordBombError("BANNED", str(body.banReason, "this bot is banned"), res.status);
    if (res.status === 503) {
      const seconds = Number(res.headers.get("retry-after"));
      throw new WordBombError("BOTS_DISABLED", `bot login 503: ${errorText(data) ?? "bots are turned off"}, try again later`, 503, Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined);
    }
    if (!res.ok) throw httpError("bot login", res, data, text);
    const token = str(body.token);
    if (!token) throw new WordBombError("AUTH_FAILED", "bot login returned no token", res.status);
    const user = record(body.user);
    const userData = record(user.data);
    const claim = claims(token).app;
    this.token = token;
    this.kind = claim === 1 || claim === true || userData.app === true || user.app === true ? "app" : "bot";
    this.me.id = str(user.id, this.me.id);
    this.me.name = str(userData.displayName) || str(user.displayName) || str(user.username) || this.me.name;
    this.me.data = Object.keys(userData).length ? userData : user;
    for (const fn of this.listeners) fn(token);
    this.schedule(REFRESH_MS);
  }

  private schedule(ms: number): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.refresh().catch((e: unknown) => {
        const err = e instanceof Error ? e : new Error(String(e));
        if (err instanceof WordBombError && err.code === "BANNED") {
          this.onBanned();
          return;
        }
        this.onError(err);
        if (err instanceof WordBombError && err.code === "AUTH_FAILED") return;
        this.schedule(RETRY_MS);
      });
    }, ms);
  }
}
