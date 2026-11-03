import type { Http } from "./http.js";
import type { Notification, NotificationKind } from "./types.js";
import { list, num, record, str } from "./util.js";

function kindOf(type: string, key: string, data: Record<string, unknown>): NotificationKind {
  if (key === "notification.profile_comment") return "profile_comment";
  if (key === "notification.comment_reply") return "comment_reply";
  if (type === "achievement") return "achievement";
  if (data.buyerName) return "gift";
  return "other";
}

function toNotification(entry: unknown): Notification {
  const n = record(entry);
  const data = record(n.data);
  const type = str(n.type);
  const key = str(data.key);
  const fromName = str(data.authorName) || str(data.buyerName);
  const fromId = str(data.authorId);
  let text = str(n.message);
  if (key && (!text || text === key)) text = key.replace(/^notification\./, "").replace(/_/g, " ");
  text = text.replace("{name}", fromName || "someone");
  const kind = kindOf(type, key, data);
  if (kind === "achievement" && (data.name || data.id)) text = `achievement unlocked: ${str(data.name) || str(data.id)}`;
  return {
    at: num(n.ts),
    kind,
    type,
    key,
    text,
    from: fromId ? { id: fromId, name: fromName } : null,
    data,
  };
}

export class Notifications {
  private lastSeen = 0;
  private running = false;
  private again = false;

  constructor(private readonly http: Http) {}

  async list(): Promise<Notification[]> {
    const r = record(await this.http.get("player", "/notifications"));
    const all = list(r.n).map(toNotification).sort((a, b) => b.at - a.at);
    for (const n of all) this.lastSeen = Math.max(this.lastSeen, n.at);
    return all;
  }

  async prime(): Promise<void> {
    await this.list();
    if (!this.lastSeen) this.lastSeen = Date.now();
  }

  async poll(deliver: (fresh: Notification[]) => void): Promise<void> {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        const since = this.lastSeen;
        const all = await this.list();
        const fresh = all.filter((n) => n.at > since).sort((a, b) => a.at - b.at);
        if (fresh.length) deliver(fresh);
      } while (this.again);
    } finally {
      this.running = false;
    }
  }
}
