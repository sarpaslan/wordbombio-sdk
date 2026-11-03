import { WordBombError } from "./errors.js";
import type { Lobby, Rooms } from "./rooms.js";
import type { Session } from "./session.js";
import type { CosmeticKind } from "./types.js";
import { num } from "./util.js";

interface KindSpec {
  owned: string;
  equipped: string;
  message: string;
  none?: number;
}

const KINDS: Record<CosmeticKind, KindSpec> = {
  bomb: { owned: "bombs", equipped: "bomb", message: "equip-bomb" },
  heart: { owned: "hearts", equipped: "heart", message: "equip-heart" },
  ghost: { owned: "ghosts", equipped: "ghost", message: "equip-ghost", none: -1 },
  streak: { owned: "streaks", equipped: "streak", message: "equip-streak" },
  letter: { owned: "letters", equipped: "letter", message: "equip-letter" },
  explosion: { owned: "explosions", equipped: "explosion", message: "equip-explosion" },
  combo: { owned: "comboSkins", equipped: "comboSkin", message: "equip-combo" },
};

export const COSMETIC_KINDS = Object.keys(KINDS) as CosmeticKind[];

export class Cosmetics {
  constructor(
    private readonly session: Session,
    private readonly rooms: Rooms,
    private readonly lobby: Lobby,
  ) {}

  owned(kind: CosmeticKind): number[] {
    const raw = this.session.me.data[KINDS[kind].owned];
    if (typeof raw === "string") return raw.split(",").filter(Boolean).map(Number);
    return Array.isArray(raw) ? raw.map((v) => num(v)) : [];
  }

  equipped(kind: CosmeticKind): number {
    const spec = KINDS[kind];
    return num(this.session.me.data[spec.equipped], spec.none ?? 0);
  }

  async equip(kind: CosmeticKind, id: number): Promise<void> {
    const spec = KINDS[kind];
    const off = spec.none !== undefined && id === spec.none;
    if (!off && id !== 0 && !this.owned(kind).includes(id)) await this.session.refresh();
    if (!off && id !== 0 && !this.owned(kind).includes(id)) throw new WordBombError("FORBIDDEN", `this bot does not own ${kind} ${id}`);
    const rooms = this.rooms.all.filter((room) => room.isOpen);
    for (const room of rooms) room.raw.send(spec.message, { id });
    if (!rooms.length) await this.lobby.send(spec.message, { id });
    this.session.me.data[spec.equipped] = id;
  }
}
