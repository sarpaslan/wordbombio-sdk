import { Client } from "@colyseus/sdk";
import { Apps } from "./app.js";
import { Commands } from "./commands.js";
import { Cosmetics } from "./cosmetics.js";
import { Emitter } from "./emitter.js";
import { WordBombError } from "./errors.js";
import { Http } from "./http.js";
import { Interactions } from "./interactions.js";
import { ImageSlot } from "./media.js";
import { Notifications } from "./notifications.js";
import { Realtime } from "./realtime.js";
import { ROOM_EVENTS, type GameRoom, type RoomEvents } from "./room.js";
import { Lobby, Rooms } from "./rooms.js";
import { Session, type BotKind } from "./session.js";
import { Comments, Dms, Friends, friendRoom, OwnProfile, Users, type DirectMessage, type FriendRequest, type Invite, type UserLike } from "./social.js";
import { resolveTarget, type Target, type TargetName } from "./targets.js";
import type { FriendRoom, Notification, UserRef } from "./types.js";
import { list, num, record, str } from "./util.js";

const NOTIFY_MAX = 200;

export interface ConnectOptions {
  key: string;
  target: TargetName | Target;
  locale?: string;
  realtime?: boolean;
  keepRoomsAlive?: boolean;
  rejoinRooms?: boolean;
  clientId?: string;
}

export interface ReceivedInvite extends Invite {
  join(): Promise<GameRoom>;
}

export interface BotEvents extends RoomEvents {
  error: Error;
  banned: void;
  "realtime.up": void;
  "realtime.down": { code: number; retryInMs: number };
  "room.joined": { room: GameRoom };
  "dm.message": DirectMessage;
  notification: Notification;
  "profile.comment": Notification;
  achievement: Notification;
  "friend.request": FriendRequest;
  "friend.request.canceled": { id: string };
  "friend.added": UserRef;
  "friend.removed": { id: string };
  "friend.online": { id: string; name: string; status: string };
  "friend.offline": { id: string; name: string };
  "friend.room": { id: string; name: string; room: FriendRoom | null };
  "invite.received": ReceivedInvite;
}

export class WordBomb extends Emitter<BotEvents> {
  readonly target: Target;
  readonly http: Http;
  readonly realtime: Realtime | null;
  readonly users: Users;
  readonly dm: Dms;
  readonly friends: Friends;
  readonly comments: Comments;
  readonly profile: OwnProfile;
  readonly notifications: Notifications;
  readonly lobby: Lobby;
  readonly rooms: Rooms;
  readonly apps: Apps;
  readonly commands: Commands;
  readonly cosmetics: Cosmetics;
  readonly avatar: ImageSlot;
  readonly banner: ImageSlot;
  readonly background: ImageSlot;
  private readonly session: Session;
  private readonly client: Client;
  private readonly interactions: Interactions;
  private closed = false;
  private readonly requested = new Set<string>();

  static async connect(opts: ConnectOptions): Promise<WordBomb> {
    const bot = new WordBomb(opts);
    await bot.session.refresh();
    await Promise.all([
      bot.notifications.prime().catch((e: unknown) => bot.fail(e)),
      bot.kind === "app" ? Promise.resolve() : bot.friends.list().catch((e: unknown) => bot.fail(e)),
    ]);
    bot.start();
    return bot;
  }

  private constructor(opts: ConnectOptions) {
    super();
    this.target = resolveTarget(opts.target);
    const locale = opts.locale ?? "en-US";
    this.session = new Session(
      this.target,
      opts.key,
      (e) => this.fail(e),
      () => this.emit("banned", undefined),
    );
    this.client = new Client(this.target.gameWs);
    this.session.onToken((token) => {
      this.client.auth.token = token;
    });
    this.http = new Http(this.session);
    this.realtime = opts.realtime === false ? null : new Realtime(this.session, opts.clientId ?? "bot");
    this.users = new Users(this.http);
    this.dm = new Dms(this.http, this.users, this.session);
    this.friends = new Friends(this.http, this.users, this.realtime);
    this.comments = new Comments(this.http, this.users, this.session);
    this.profile = new OwnProfile(this.http, this.users, this.session);
    this.notifications = new Notifications(this.http);
    this.commands = new Commands(this.http, this.session);
    this.interactions = new Interactions(this.realtime, this.session, this.commands);
    this.apps = new Apps(this.interactions, this.realtime);
    this.lobby = new Lobby(this.client, locale);
    this.rooms = new Rooms(this.client, {
      locale,
      keepAlive: opts.keepRoomsAlive !== false,
      rejoin: opts.rejoinRooms !== false,
      myName: () => this.session.me.name,
      isApp: () => this.session.kind === "app",
      channel: (room, sink) => this.interactions.attach(room, sink, true),
      adopted: (room) => this.adopt(room),
      failed: (e) => this.fail(e),
    });
    this.cosmetics = new Cosmetics(this.session, this.rooms, this.lobby);
    this.avatar = new ImageSlot(this.http, "avatar");
    this.banner = new ImageSlot(this.http, "banner");
    this.background = new ImageSlot(this.http, "background");
  }

  get me(): Readonly<UserRef> {
    return { id: this.session.me.id, name: this.session.me.name };
  }

  get token(): string {
    return this.session.token;
  }

  get kind(): BotKind {
    return this.session.kind;
  }

  async notify(user: UserLike, text: string): Promise<void> {
    if (this.kind !== "app") throw new WordBombError("FORBIDDEN", "only applications send notifications");
    const body = text.trim();
    if (!body || body.length > NOTIFY_MAX) throw new WordBombError("INVALID", `notification text must be 1 to ${NOTIFY_MAX} characters`);
    await this.http.post("player", "/apps/notify", { to: await this.users.resolve(user), text: body });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.rooms.leaveAll().catch(() => {});
    this.realtime?.close();
    this.session.close();
  }

  private start(): void {
    const rt = this.realtime;
    if (!rt) return;
    rt.on("event", ({ e, d }) => this.onRealtime(e, d));
    rt.on("up", () => {
      this.interactions.resubscribe();
      this.emit("realtime.up", undefined);
    });
    rt.on("down", (info) => this.emit("realtime.down", info));
    rt.on("banned", () => this.emit("banned", undefined));
    rt.on("replaced", () => this.fail(new WordBombError("REPLACED", "another process connected with this key, so this one stopped getting DMs, invites and commands")));
    rt.connect();
  }

  private fail(e: unknown): void {
    this.emit("error", e instanceof Error ? e : new WordBombError("HTTP", String(e)));
  }

  private adopt(room: GameRoom): void {
    const relay = this.emit.bind(this) as (event: keyof BotEvents, payload: unknown) => void;
    for (const name of ROOM_EVENTS) room.on(name, (payload) => relay(name, payload));
    this.emit("room.joined", { room });
  }

  private friendName(id: string): string {
    return this.users.nameOf(id) || "a friend";
  }

  private request(from: UserRef): void {
    if (this.requested.has(from.id)) return;
    this.requested.add(from.id);
    const req = this.friends.friendRequest(from);
    this.emit("friend.request", { ...req, decline: () => { this.requested.delete(from.id); return req.decline(); } });
  }

  private async pendingRequests(): Promise<void> {
    if (this.kind === "app") return;
    const { incoming } = await this.friends.list();
    for (const from of incoming) this.request(from);
  }

  private onRealtime(e: string, d: unknown): void {
    const data = record(d);
    const id = str(data.id);
    switch (e) {
      case "bot:cmd":
      case "bot:btn":
        this.interactions.receive(e, d);
        return;
      case "notif":
        this.notifications
          .poll((fresh) => {
            for (const n of fresh) {
              this.emit("notification", n);
              if (n.kind === "profile_comment" || n.kind === "comment_reply") this.emit("profile.comment", n);
              if (n.kind === "achievement") this.emit("achievement", n);
            }
          })
          .catch((err: unknown) => this.fail(err));
        return;
      case "inbox": {
        const message = this.dm.fromRealtime(d);
        if (message) this.emit("dm.message", message);
        return;
      }
      case "friends:init":
        for (const entry of list(data.online)) {
          const f = record(entry);
          const fid = str(f.id);
          if (fid) this.friends.online.set(fid, { status: str(f.status, "online"), room: friendRoom(f.room) });
        }
        if (num(data.requestsCount) > 0) this.pendingRequests().catch((e: unknown) => this.fail(e));
        return;
      case "friend:room": {
        if (!id) return;
        const room = friendRoom(data.room);
        const presence = this.friends.online.get(id);
        if (presence) presence.room = room;
        this.emit("friend.room", { id, name: this.friendName(id), room });
        return;
      }
      case "friend:online":
        if (!id) return;
        this.friends.online.set(id, { status: str(data.status, "online"), room: this.friends.online.get(id)?.room ?? null });
        this.emit("friend.online", { id, name: this.friendName(id), status: str(data.status, "online") });
        return;
      case "friend:offline":
        if (!id) return;
        this.friends.online.delete(id);
        this.emit("friend.offline", { id, name: this.friendName(id) });
        return;
      case "friend:request": {
        const ref = this.userRef(data.friend);
        if (ref) this.request(ref);
        return;
      }
      case "friend:request_canceled":
        if (!id) return;
        this.requested.delete(id);
        this.emit("friend.request.canceled", { id });
        return;
      case "friend:added": {
        const ref = this.userRef(data.friend);
        if (!ref) return;
        this.requested.delete(ref.id);
        this.emit("friend.added", ref);
        return;
      }
      case "friend:removed":
        if (!id) return;
        this.friends.online.delete(id);
        this.emit("friend.removed", { id });
        return;
      case "friend:invite": {
        const fromId = str(data.fromId);
        if (!fromId) return;
        const from = { id: fromId, name: str(data.fromName) || this.friendName(fromId) };
        this.users.remember(from.id, from.name);
        const roomId = str(data.roomId) || null;
        this.emit("invite.received", {
          from,
          roomId,
          join: () => (roomId ? this.rooms.join(roomId) : Promise.reject(new WordBombError("INVALID", "this invite has no room"))),
        });
        return;
      }
    }
  }

  private userRef(value: unknown): UserRef | null {
    const f = record(value);
    const id = str(f.id);
    if (!id) return null;
    const ref = { id, name: str(f.displayName) || str(f.name) || "someone" };
    this.users.remember(ref.id, ref.name);
    return ref;
  }
}
