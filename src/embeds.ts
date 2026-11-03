import { invalid } from "./errors.js";
import { record } from "./util.js";

export type ButtonStyle = 1 | 2 | 3 | 4;

export interface BotButton {
  type?: 2;
  style: ButtonStyle;
  label: string;
  custom_id: string;
  disabled?: boolean;
}

export interface BotActionRow {
  type?: 1;
  components: BotButton[];
}

export interface BotEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface BotEmbed {
  title?: string;
  url?: string;
  description?: string;
  author?: { name: string };
  fields?: BotEmbedField[];
  thumbnail?: { url: string };
  image?: { url: string };
  footer?: { text: string };
  components?: BotActionRow[];
}

export interface BotMessage {
  text?: string;
  embed?: BotEmbed;
}

export interface BotReply extends BotMessage {
  ephemeral?: boolean;
}

export interface WireMessage {
  t?: string;
  e?: BotEmbed;
}

export const CDN_HOST = "wcdn.wordbomb.io";

const TEXT_MAX = 2000;
const TOTAL_MAX = 6000;
const TITLE_MAX = 256;
const DESCRIPTION_MAX = 2048;
const AUTHOR_MAX = 64;
const FIELDS_MAX = 10;
const FIELD_NAME_MAX = 64;
const FIELD_VALUE_MAX = 512;
const FOOTER_MAX = 128;
const ROWS_MAX = 2;
const BUTTONS_MAX = 5;
const LABEL_MAX = 40;
const CUSTOM_ID_MAX = 64;
const STYLES: readonly ButtonStyle[] = [1, 2, 3, 4];

const absent = (value: unknown) => value === undefined || value === null;

function optionalText(value: unknown, path: string, max: number): string | undefined {
  if (absent(value)) return undefined;
  if (typeof value !== "string") throw invalid(path, "must be a string");
  if (value.length > max) throw invalid(path, `is ${value.length} characters, the limit is ${max}`);
  return value.trim() ? value : undefined;
}

function requiredText(value: unknown, path: string, max: number): string {
  const text = optionalText(value, path, max);
  if (!text) throw invalid(path, "is required");
  return text;
}

function parseHttps(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function httpsUrl(value: unknown, path: string): string | undefined {
  const text = optionalText(value, path, Infinity);
  if (!text) return undefined;
  if (!parseHttps(text)) throw invalid(path, "must be an https URL");
  return text;
}

function urlObject(value: unknown, path: string): { url: string } | undefined {
  if (absent(value)) return undefined;
  const url = httpsUrl(record(value).url, `${path}.url`);
  if (!url) throw invalid(`${path}.url`, "is required");
  return { url };
}

function array(value: unknown, path: string, max: number): unknown[] | undefined {
  if (absent(value)) return undefined;
  if (!Array.isArray(value)) throw invalid(path, "must be an array");
  if (value.length > max) throw invalid(path, `has ${value.length} entries, the limit is ${max}`);
  return value;
}

function buttonStyle(value: unknown, path: string): ButtonStyle {
  if (absent(value)) return 1;
  const style = STYLES.find((s) => s === value);
  if (style === undefined) throw invalid(path, "must be 1 (primary), 2 (secondary), 3 (success) or 4 (danger)");
  return style;
}

function button(value: unknown, path: string, ids: Set<string>): BotButton {
  const b = record(value);
  if (!absent(b.url)) throw invalid(path, "can't be a link button");
  if (!absent(b.type) && b.type !== 2) throw invalid(`${path}.type`, "must be 2");
  const id = requiredText(b.custom_id, `${path}.custom_id`, CUSTOM_ID_MAX);
  if (ids.has(id)) throw invalid(`${path}.custom_id`, `"${id}" is used twice in this message`);
  ids.add(id);
  const out: BotButton = { type: 2, style: buttonStyle(b.style, `${path}.style`), label: requiredText(b.label, `${path}.label`, LABEL_MAX), custom_id: id };
  if (b.disabled === true) out.disabled = true;
  return out;
}

export function embedFrom(value: unknown): BotEmbed {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("embed", "must be an object");
  const e = record(value);
  const out: BotEmbed = {};
  const title = optionalText(e.title, "embed.title", TITLE_MAX);
  if (title) out.title = title;
  const url = httpsUrl(e.url, "embed.url");
  if (url) out.url = url;
  const description = optionalText(e.description, "embed.description", DESCRIPTION_MAX);
  if (description) out.description = description;
  if (!absent(e.author)) out.author = { name: requiredText(record(e.author).name, "embed.author.name", AUTHOR_MAX) };
  const fields = array(e.fields, "embed.fields", FIELDS_MAX);
  if (fields?.length) {
    out.fields = fields.map((entry, index) => {
      const f = record(entry);
      const path = `embed.fields[${index}]`;
      const field: BotEmbedField = { name: requiredText(f.name, `${path}.name`, FIELD_NAME_MAX), value: requiredText(f.value, `${path}.value`, FIELD_VALUE_MAX) };
      if (f.inline === true) field.inline = true;
      return field;
    });
  }
  const thumbnail = urlObject(e.thumbnail, "embed.thumbnail");
  if (thumbnail) out.thumbnail = thumbnail;
  const image = urlObject(e.image, "embed.image");
  if (image) out.image = image;
  if (!absent(e.footer)) out.footer = { text: requiredText(record(e.footer).text, "embed.footer.text", FOOTER_MAX) };
  const rows = array(e.components, "embed.components", ROWS_MAX);
  if (rows?.length) {
    const ids = new Set<string>();
    out.components = rows.map((entry, index) => {
      const row = record(entry);
      const path = `embed.components[${index}]`;
      if (!absent(row.type) && row.type !== 1) throw invalid(`${path}.type`, "must be 1");
      const buttons = array(row.components, `${path}.components`, BUTTONS_MAX);
      if (!buttons?.length) throw invalid(`${path}.components`, "needs at least one button");
      return { type: 1, components: buttons.map((b, i) => button(b, `${path}.components[${i}]`, ids)) };
    });
  }
  return out;
}

function checkImage(image: { url: string } | undefined, path: string, ownAvatar: string | null): void {
  if (!image || image.url === ownAvatar) return;
  if (parseHttps(image.url)?.hostname !== CDN_HOST) throw invalid(path, `must be on ${CDN_HOST} or be your own avatar URL`);
}

function embedText(embed: BotEmbed): number {
  let total = (embed.title?.length ?? 0) + (embed.description?.length ?? 0) + (embed.author?.name.length ?? 0) + (embed.footer?.text.length ?? 0);
  for (const f of embed.fields ?? []) total += f.name.length + f.value.length;
  return total;
}

export function wireMessage(message: BotMessage, ownAvatar: string | null): WireMessage {
  const m = record(message);
  const text = optionalText(m.text, "text", TEXT_MAX);
  const embed = absent(m.embed) ? undefined : embedFrom(m.embed);
  const out: WireMessage = {};
  if (text) out.t = text;
  if (embed) {
    checkImage(embed.thumbnail, "embed.thumbnail.url", ownAvatar);
    checkImage(embed.image, "embed.image.url", ownAvatar);
    if (Object.keys(embed).length) out.e = embed;
  }
  const visible = !!embed && !!(embed.title || embed.description || embed.author || embed.fields || embed.thumbnail || embed.image || embed.footer);
  if (!text && !visible) throw invalid("message", "needs text or an embed with a title, description, author, fields, thumbnail, image or footer");
  const total = (text?.length ?? 0) + (embed ? embedText(embed) : 0);
  if (total > TOTAL_MAX) throw invalid("message", `has ${total} characters of text, the limit is ${TOTAL_MAX}`);
  return out;
}
