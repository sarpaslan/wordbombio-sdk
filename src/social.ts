import { WordBombError } from "./errors.js";
import type { Http } from "./http.js";
import { avatarUrl } from "./media.js";
import type { Realtime } from "./realtime.js";
import type { Session } from "./session.js";
import type { Conversation, Friend, FriendRoom, HistoryMessage, Profile, UserRef } from "./types.js";
import { chatIdWith, isUserId, list, num, record, str } from "./util.js";

export type UserLike = string | UserRef;

const DM_MAX = 400;
const COMMENT_MAX = 500;

export class Users {
  private readonly byName = new Map<string, string>();
  private readonly names = new Map<string, string>();

  constructor(private readonly http: Http) {}

  async resolve(ref: UserLike): Promise<string> {
    if (typeof ref !== "string") return ref.id;
    const value = ref.trim();
    if (!value) throw new WordBombError("INVALID", "empty user reference");
    if (isUserId(value)) return value;
    const cached = this.byName.get(value.toLowerCase());
    if (cached) return cached;
    const r = record(await this.http.get(`player`, `/profile/username/${encodeURIComponent(value)}`));
    const id = str(r.id);
    if (!id) throw new WordBombError("NOT_FOUND", `no player named ${value}`);
    this.byName.set(value.toLowerCase(), id);
    return id;
  }

  async get(ref: UserLike): Promise<Profile> {
    const id = await this.resolve(ref);
    const r = record(await this.http.get("player", `/profile/${id}`));
    const p = record(r.p);
    const name = str(p.displayName) || str(p.username) || id;
    this.remember(id, name);
    return {
      id,
      name,
      username: str(p.username),
      avatar: str(p.avatar),
      avatarUrl: avatarUrl(id, str(p.avatar)),
      about: str(p.about) || str(p.aboutMe),
      exp: num(p.exp),
      wins: num(p.win),
      score: num(p.score),
      wp: num(p.wp),
      clan: str(record(r.clan).name) || null,
      isFriend: r.friend === true,
      raw: p,
    };
  }

  remember(id: string, name: string): void {
    if (id && name) this.names.set(id, name);
  }

  nameOf(id: string): string {
    return this.names.get(id) ?? "";
  }
}

export interface DirectMessage {
  chatId: string;
  group: boolean;
  from: UserRef;
  kind: string;
  text: string | null;
  reply(text: string): Promise<void>;
}

export class Dms {
  constructor(
    private readonly http: Http,
    private readonly users: Users,
    private readonly session: Session,
  ) {}

  async send(to: UserLike, text: string): Promise<void> {
    const id = await this.users.resolve(to);
    await this.sendToChat(chatIdWith(this.session.me.id, id), text);
  }

  async sendToChat(chatId: string, text: string): Promise<void> {
    const body = text.trim().slice(0, DM_MAX);
    if (!body) throw new WordBombError("INVALID", "message is empty");
    const r = record(await this.http.post("social", `/inbox/${encodeURIComponent(chatId)}/send`, { t: body }));
    if (r.i === "0") throw new WordBombError("LINK_DROPPED", "messages with links are dropped");
  }

  async history(withUser: UserLike, limit = 20): Promise<HistoryMessage[]> {
    const id = await this.users.resolve(withUser);
    const l = Math.min(Math.max(Math.round(limit), 1), 100);
    const r = record(await this.http.get("social", `/inbox/${chatIdWith(this.session.me.id, id)}?l=${l}`));
    return list(r.d)
      .map((entry) => {
        const m = record(entry);
        const kind = str(m.y, "text");
        return { senderId: str(m.s), mine: str(m.s) === this.session.me.id, kind, text: kind === "text" ? str(m.t) : null };
      })
      .reverse();
  }

  async inbox(limit = 20): Promise<Conversation[]> {
    const l = Math.min(Math.max(Math.round(limit), 1), 50);
    const r = record(await this.http.get("social", `/inbox?l=${l}`));
    return list(r.d).map((entry) => {
      const c = record(entry);
      const other = list(c.p).map(record).find((p) => str(p.id) !== this.session.me.id);
      const last = c.l ? record(c.l) : null;
      const lastKind = last ? str(last.y, "text") : "";
      if (other) this.users.remember(str(other.id), str(other.displayName));
      return {
        chatId: str(c.i),
        group: !!c.g,
        with: other ? { id: str(other.id), name: str(other.displayName) } : null,
        unread: num(c.nc),
        last: last ? { senderId: str(last.s), kind: lastKind, text: lastKind === "text" ? str(last.t) : null } : null,
      };
    });
  }

  fromRealtime(d: unknown): DirectMessage | null {
    const payload = record(d);
    const m = record(payload.m);
    const senderId = str(m.s);
    const kind = str(m.y, "text");
    if (!senderId || senderId === this.session.me.id || kind === "deleted" || kind === "system") return null;
    const chatId = str(payload.i);
    const name = str(record(payload.u).n) || this.users.nameOf(senderId) || "someone";
    this.users.remember(senderId, name);
    const group = chatId.split("_").length !== 2;
    return {
      chatId,
      group,
      from: { id: senderId, name },
      kind,
      text: kind === "text" ? str(m.t) : null,
      reply: (text) => (group ? this.sendToChat(chatId, text) : this.send(senderId, text)),
    };
  }
}

export interface FriendRequest {
  from: UserRef;
  accept(): Promise<void>;
  decline(): Promise<void>;
}

export interface Invite {
  from: UserRef;
  roomId: string | null;
}

export interface InviteResult {
  delivered: boolean;
  reason: string | null;
}

export class Friends {
  readonly online = new Map<string, { status: string; room: FriendRoom | null }>();

  constructor(
    private readonly http: Http,
    private readonly users: Users,
    private readonly realtime: Realtime | null,
  ) {}

  async list(): Promise<{ friends: Friend[]; incoming: UserRef[] }> {
    const [friends, requests] = await Promise.all([this.http.get("player", "/friends"), this.http.get("player", "/friends/requests")]);
    const toRef = (entry: unknown): UserRef => {
      const f = record(entry);
      const ref = { id: str(f.id), name: str(f.displayName) };
      this.users.remember(ref.id, ref.name);
      return ref;
    };
    return {
      friends: list(record(friends).mapped).map((entry) => {
        const ref = toRef(entry);
        const presence = this.online.get(ref.id);
        return { ...ref, online: !!presence, status: presence?.status ?? null, room: presence?.room ?? null };
      }),
      incoming: list(record(requests).mapped).map(toRef),
    };
  }

  async accept(user: UserLike): Promise<void> {
    await this.http.post("player", "/friends/accept", { friendId: await this.users.resolve(user) });
  }

  async decline(user: UserLike): Promise<void> {
    await this.http.delete("player", "/friends/request", { friendId: await this.users.resolve(user) });
  }

  async remove(user: UserLike): Promise<void> {
    await this.http.delete("player", `/friends/${encodeURIComponent(await this.users.resolve(user))}`);
  }

  async invite(user: UserLike, roomId: string | null): Promise<InviteResult> {
    if (!this.realtime) throw new WordBombError("REALTIME_DOWN", "invites need the realtime connection (connect with realtime: true)");
    const r = record(await this.realtime.request("friend:invite", { friendId: await this.users.resolve(user), roomId }));
    return { delivered: r.delivered === true, reason: str(r.reason) || null };
  }

  friendRequest(user: UserRef): FriendRequest {
    return { from: user, accept: () => this.accept(user), decline: () => this.decline(user) };
  }
}

export function friendRoom(value: unknown): FriendRoom | null {
  const r = record(value);
  const id = str(r.id);
  if (!id) return null;
  return { id, locked: r.locked === true || r.kind === "private", started: r.started === true, players: num(r.players) };
}

export interface Comment {
  id: string;
  profileId: string;
  parentId: string | null;
  author: UserRef;
  text: string;
  at: number;
  pinned: boolean;
  reply(text: string): Promise<Comment>;
}

export interface CommentThread extends Comment {
  replies: Comment[];
}

export class Comments {
  constructor(
    private readonly http: Http,
    private readonly users: Users,
    private readonly session: Session,
  ) {}

  async list(profile?: UserLike, limit = 20): Promise<{ total: number; canComment: boolean; threads: CommentThread[] }> {
    const profileId = profile ? await this.users.resolve(profile) : this.session.me.id;
    const l = Math.min(Math.max(Math.round(limit), 1), 50);
    const r = record(await this.http.get("player", `/profile/comments/${profileId}?l=${l}`));
    const all = list(r.comments).map((entry) => this.toComment(record(entry), profileId));
    const threads: CommentThread[] = all
      .filter((c) => !c.parentId)
      .map((c) => ({ ...c, replies: all.filter((x) => x.parentId === c.id) }));
    return { total: num(r.total, threads.length), canComment: r.canComment !== false, threads };
  }

  async post(profile: UserLike, text: string): Promise<Comment> {
    return this.create({ profileId: await this.users.resolve(profile) }, text);
  }

  async reply(to: Comment, text: string): Promise<Comment> {
    const target: Record<string, string> = { profileId: to.profileId, parentId: to.parentId ?? to.id };
    if (to.parentId) target.replyToId = to.id;
    return this.create(target, text);
  }

  private async create(target: Record<string, string>, text: string): Promise<Comment> {
    const body = text.trim().slice(0, COMMENT_MAX);
    if (!body) throw new WordBombError("INVALID", "comment is empty");
    const r = record(await this.http.post("player", "/profile/comment/create", { ...target, text: body }));
    if (r.success !== true) throw new WordBombError("FORBIDDEN", `comment not posted: ${str(r.error, "unknown reason")}`);
    const c = record(r.comment);
    return this.toComment(
      { ...c, id: str(c.id), r: target.parentId ?? null, authorId: this.session.me.id, authorName: this.session.me.name, text: str(c.text, body) },
      str(target.profileId),
    );
  }

  private toComment(c: Record<string, unknown>, profileId: string): Comment {
    const comment: Comment = {
      id: str(c.id),
      profileId,
      parentId: str(c.r) || null,
      author: { id: str(c.authorId), name: str(c.authorName) },
      text: str(c.text),
      at: typeof c.timestamp === "number" ? c.timestamp : Date.parse(str(c.timestamp)) || 0,
      pinned: c.pinned === true,
      reply: (text) => this.reply(comment, text),
    };
    this.users.remember(comment.author.id, comment.author.name);
    return comment;
  }
}

export class OwnProfile {
  constructor(
    private readonly http: Http,
    private readonly users: Users,
    private readonly session: Session,
  ) {}

  get(): Promise<Profile> {
    return this.users.get(this.session.me.id);
  }

  async update(fields: { displayName?: string; about?: string }): Promise<void> {
    const body: Record<string, string> = {};
    if (fields.displayName !== undefined) body.displayName = fields.displayName;
    if (fields.about !== undefined) body.aboutMe = fields.about;
    if (!Object.keys(body).length) return;
    const r = record(await this.http.post("game", "/profile/update", body));
    if (r.cooldown) throw new WordBombError("RATE_LIMITED", `name change on cooldown (${str(r.cooldown, String(r.cooldown))})`);
    if (r.success !== true) throw new WordBombError("FORBIDDEN", `profile not updated: ${str(r.error, "unknown reason")}`);
    if (body.displayName) this.session.me.name = body.displayName;
  }
}
