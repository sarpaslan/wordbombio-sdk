import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { WordBombError } from "./errors.js";
import type { Http } from "./http.js";
import type { ImageKind } from "./types.js";
import { record, str } from "./util.js";

const MAX_BYTES = 2 * 1024 * 1024;
const SITE = "https://wordbomb.io";

const ROUTES: Record<ImageKind, { start: string; confirm: string }> = {
  avatar: { start: "/profile/avatar/upload-url", confirm: "/profile/avatar/confirm" },
  banner: { start: "/profile/pbg/upload-url", confirm: "/profile/pbg/confirm" },
  background: { start: "/profile/background/upload-url", confirm: "/profile/background/confirm" },
};

const EXTENSIONS: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

export type ImageInput = string | Uint8Array | ArrayBuffer;

function sniff(bytes: Uint8Array): string | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const riff = String.fromCharCode(...bytes.subarray(0, 4));
  const webp = String.fromCharCode(...bytes.subarray(8, 12));
  if (riff === "RIFF" && webp === "WEBP") return "image/webp";
  return null;
}

async function load(input: ImageInput): Promise<{ bytes: Uint8Array<ArrayBuffer>; type: string }> {
  let bytes: Uint8Array<ArrayBuffer>;
  let type: string | null = null;
  if (typeof input === "string") {
    type = EXTENSIONS[extname(input).toLowerCase()] ?? null;
    if (!type) throw new WordBombError("INVALID", "images must be .png, .jpg or .webp");
    try {
      bytes = new Uint8Array(await readFile(input));
    } catch (e) {
      throw new WordBombError("INVALID", `could not read ${input}: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    bytes = new Uint8Array(input instanceof Uint8Array ? input : new Uint8Array(input));
  }
  type = sniff(bytes) ?? type;
  if (!type) throw new WordBombError("INVALID", "images must be png, jpeg or webp");
  if (bytes.byteLength > MAX_BYTES) throw new WordBombError("INVALID", "images must be under 2 MB");
  return { bytes, type };
}

export class ImageSlot {
  constructor(
    private readonly http: Http,
    readonly kind: ImageKind,
  ) {}

  async upload(input: ImageInput): Promise<string> {
    const { bytes, type } = await load(input);
    const route = ROUTES[this.kind];
    const signed = record(await this.http.post("player", route.start, { contentType: type }));
    const url = str(signed.url);
    const publicUrl = str(signed.publicUrl);
    if (!url || !publicUrl) throw new WordBombError("HTTP", `${this.kind} upload got no signed url`);
    const put = await fetch(url, { method: "PUT", headers: { "Content-Type": type }, body: bytes }).catch((e: unknown) => {
      throw new WordBombError("HTTP", `${this.kind} upload failed: ${e instanceof Error ? e.message : String(e)}`);
    });
    if (!put.ok) throw new WordBombError("HTTP", `${this.kind} upload failed with ${put.status}`, put.status);
    await this.http.post("player", route.confirm, { url: publicUrl });
    return publicUrl;
  }
}

export function avatarUrl(userId: string, avatar: string): string | null {
  if (!userId || !avatar) return null;
  if (avatar.includes("wcdn.wordbomb.io/") || avatar.includes("cdn.wordbomb.io/")) return avatar;
  if (/^\d+$/.test(avatar)) return `${SITE}/avatars/${avatar}.png?v=1`;
  if (avatar.includes("google")) return avatar.replace(/=s\d+-c/, "=s256-c");
  if (/^https?:\/\//.test(avatar)) return avatar;
  return `https://cdn.discordapp.com/avatars/${userId}/${avatar}.png?size=256`;
}
