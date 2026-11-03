export interface UserRef {
  id: string;
  name: string;
}

export interface Player {
  sessionId: string;
  id: string;
  name: string;
  avatar: string;
  hearts: number;
  eliminated: boolean;
  spectating: boolean;
  isHost: boolean;
  isMe: boolean;
  isTurn: boolean;
  isGuest: boolean;
  isBot: boolean;
  language: string;
}

export interface RoomConfig {
  mode: number;
  language: string;
  multiLanguage: boolean;
  locked: boolean;
  hearts: number;
  maxPlayers: number;
  guests: boolean;
  botAccounts: boolean;
  scenario: number;
  teamMode: boolean;
  chainStyle: number;
  title: string;
}

export interface RoomListing {
  id: string;
  name: string;
  players: number;
  mode: number;
  eventRoom: boolean;
  multiLanguage: boolean;
  language: string;
  started: boolean;
  guestsAllowed: boolean;
}

export interface FriendRoom {
  id: string;
  locked: boolean;
  started: boolean;
  players: number;
}

export interface Friend extends UserRef {
  online: boolean;
  status: string | null;
  room: FriendRoom | null;
}

export interface Profile extends UserRef {
  username: string;
  avatar: string;
  avatarUrl: string | null;
  about: string;
  exp: number;
  wins: number;
  score: number;
  wp: number;
  clan: string | null;
  isFriend: boolean;
  raw: Record<string, unknown>;
}

export interface Conversation {
  chatId: string;
  group: boolean;
  with: UserRef | null;
  unread: number;
  last: { senderId: string; kind: string; text: string | null } | null;
}

export interface HistoryMessage {
  senderId: string;
  mine: boolean;
  kind: string;
  text: string | null;
}

export type NotificationKind = "profile_comment" | "comment_reply" | "achievement" | "gift" | "other";

export interface Notification {
  at: number;
  kind: NotificationKind;
  type: string;
  key: string;
  text: string;
  from: UserRef | null;
  data: Record<string, unknown>;
}

export type CosmeticKind = "bomb" | "heart" | "ghost" | "streak" | "letter" | "explosion" | "combo";

export type ImageKind = "avatar" | "banner" | "background";

export const MODES: Record<number, string> = {
  0: "original",
  1: "chain",
  5: "typing race",
  7: "dungeon",
  9: "spelling bee",
  10: "scapes",
  15: "color guesser",
  16: "button",
  17: "draw",
  18: "squad",
  22: "trivia",
  23: "chess",
  24: "map",
  26: "okey",
};

export function modeName(mode: number): string {
  return MODES[mode] ?? `mode ${mode}`;
}
