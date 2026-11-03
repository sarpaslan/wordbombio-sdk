import { invalid, WordBombError } from "./errors.js";
import type { Http } from "./http.js";
import type { Session } from "./session.js";
import { list, num, record, str } from "./util.js";

export type CommandOptionType = "string" | "number" | "player" | "message" | "choice";

export interface CommandOptionDef {
  name: string;
  description: string;
  type: CommandOptionType;
  required?: boolean;
  choices?: string[];
}

export interface CommandDef {
  name: string;
  description: string;
  options?: CommandOptionDef[];
}

const NAME = /^[a-z0-9_-]{1,32}$/;
const MAX_COMMANDS = 25;
const MAX_OPTIONS = 10;
const MAX_CHOICES = 25;
const MAX_CHOICE = 50;
const MAX_DESCRIPTION = 100;
const OPTION_TYPES: readonly CommandOptionType[] = ["string", "number", "player", "message", "choice"];
const LINK = /https?:\/\/[^\s]+|[a-z0-9][-a-z0-9]*\.(com|gg|io|net|org|fun|xyz|dev|app|me|tv|cc|co|us|uk|ru|de|fr|pro|link|click|info|biz|ws|top|site|online|live|store|space|tech|world)\b/i;
const HIDDEN = /[\u{0}-\u{1F}\u{7F}-\u{9F}\u{A0}\u{200B}\u{200C}\u{FEFF}\u{202A}-\u{202E}\u{2066}-\u{2069}]|(?<!\p{Extended_Pictographic}[\u{FE0F}\p{Emoji_Modifier}]?)\u{200D}|\u{200D}(?!\p{Extended_Pictographic})/u;
const BUILT_IN = new Set([
  "admin",
  "bm",
  "bookmark",
  "clear",
  "discord",
  "draw",
  "emergency",
  "end",
  "i",
  "invite",
  "lootbox",
  "love",
  "monster",
  "play",
  "s",
  "settings",
  "solve",
  "surrender",
  "syl",
  "title",
  "vote",
  "whisper",
]);

function nameOf(value: unknown, path: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const name = raw.startsWith("/") ? raw.slice(1) : raw;
  if (!NAME.test(name)) throw invalid(path, `"${raw}" must be 1 to 32 lowercase letters, digits, _ or -`);
  return name;
}

function textOf(value: unknown, path: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw invalid(path, "is required");
  if (value.length > max) throw invalid(path, `is ${value.length} characters, the limit is ${max}`);
  if (LINK.test(value)) throw invalid(path, "can't contain links");
  if (HIDDEN.test(value)) throw invalid(path, "can't contain control, bidi or invisible characters (tabs, line breaks, no-break or zero-width spaces)");
  return value;
}

function choicesOf(value: unknown, path: string, last: boolean): string[] {
  if (!Array.isArray(value) || !value.length) throw invalid(path, "needs at least one choice");
  if (value.length > MAX_CHOICES) throw invalid(path, `has ${value.length} choices, the limit is ${MAX_CHOICES}`);
  return value.map((choice, index) => {
    const text = textOf(choice, `${path}[${index}]`, MAX_CHOICE);
    if (!last && /\s/.test(text)) throw invalid(`${path}[${index}]`, "can only contain spaces when it is the last option");
    return text;
  });
}

function optionsOf(value: unknown, path: string): CommandOptionDef[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw invalid(path, "must be an array");
  if (value.length > MAX_OPTIONS) throw invalid(path, `has ${value.length} options, the limit is ${MAX_OPTIONS}`);
  const names = new Set<string>();
  return value.map((entry, index) => {
    const at = `${path}[${index}]`;
    const o = record(entry);
    const name = nameOf(o.name, `${at}.name`);
    if (names.has(name)) throw invalid(`${at}.name`, `"${name}" is used twice`);
    names.add(name);
    const type = OPTION_TYPES.find((t) => t === o.type);
    if (!type) throw invalid(`${at}.type`, `must be one of ${OPTION_TYPES.join(", ")}`);
    if (type === "message" && index !== value.length - 1) throw invalid(at, "a message option must be the last option");
    const def: CommandOptionDef = { name, description: textOf(o.description, `${at}.description`, MAX_DESCRIPTION), type };
    if (o.required === true) def.required = true;
    else if (o.required !== undefined && o.required !== false) throw invalid(`${at}.required`, "must be true or false");
    if (type === "choice") def.choices = choicesOf(o.choices, `${at}.choices`, index === value.length - 1);
    else if (o.choices !== undefined) throw invalid(`${at}.choices`, "only goes with type choice");
    return def;
  });
}

export function normalizeCommands(input: unknown): CommandDef[] {
  if (!Array.isArray(input)) throw invalid("commands", "must be an array");
  if (input.length > MAX_COMMANDS) throw invalid("commands", `has ${input.length} commands, the limit is ${MAX_COMMANDS}`);
  const names = new Set<string>();
  return input.map((entry, index) => {
    const at = `commands[${index}]`;
    const c = record(entry);
    const name = nameOf(c.name, `${at}.name`);
    if (BUILT_IN.has(name)) throw invalid(`${at}.name`, `/${name} is a built-in command`);
    if (names.has(name)) throw invalid(`${at}.name`, `/${name} is defined twice`);
    names.add(name);
    const def: CommandDef = { name, description: textOf(c.description, `${at}.description`, MAX_DESCRIPTION) };
    const options = optionsOf(c.options, `${at}.options`);
    if (options.length) def.options = options;
    return def;
  });
}

function canonical(value: unknown): string {
  return JSON.stringify(
    list(value).map((entry) => {
      const c = record(entry);
      return [
        str(c.name),
        str(c.description),
        list(c.options).map((option) => {
          const o = record(option);
          return [str(o.name), str(o.description), str(o.type), o.required === true, list(o.choices).map((choice) => str(choice))];
        }),
      ];
    }),
  );
}

export class Commands {
  private current: CommandDef[] = [];
  private readonly byName = new Map<string, CommandDef>();
  private v = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly http: Http,
    private readonly session: Session,
  ) {}

  get all(): readonly CommandDef[] {
    return this.current;
  }

  get version(): number {
    return this.v;
  }

  get(name: string): CommandDef | null {
    return this.byName.get(name.startsWith("/") ? name.slice(1) : name) ?? null;
  }

  set(defs: readonly CommandDef[]): Promise<number> {
    let clean: CommandDef[];
    try {
      clean = normalizeCommands(defs);
    } catch (e) {
      return Promise.reject(e);
    }
    const run = this.queue.then(
      () => this.sync(clean),
      () => this.sync(clean),
    );
    this.queue = run.catch(() => {});
    return run;
  }

  private async sync(clean: CommandDef[]): Promise<number> {
    const remote = await this.remote();
    if (canonical(remote.cmds) !== canonical(clean)) {
      try {
        remote.v = num(record(await this.http.put("player", "/bots/me/commands", { cmds: clean })).v, remote.v);
      } catch (e) {
        if (e instanceof WordBombError && e.status === 400) throw new WordBombError("INVALID", e.message, 400);
        throw e;
      }
    }
    this.current = clean;
    this.byName.clear();
    for (const def of clean) this.byName.set(def.name, def);
    this.v = remote.v;
    return this.v;
  }

  private async remote(): Promise<{ v: number; cmds: unknown }> {
    try {
      const r = record(await this.http.get("player", `/bots/${this.session.me.id}/commands`));
      return { v: num(r.v), cmds: r.cmds ?? [] };
    } catch (e) {
      if (e instanceof WordBombError && e.code === "NOT_FOUND") return { v: 0, cmds: [] };
      throw e;
    }
  }
}
