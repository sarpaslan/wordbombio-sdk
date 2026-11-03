import type { GameRoom, Turn } from "./room.js";
import { sleep } from "./util.js";
import { WordList } from "./words.js";

export interface AutoplayOptions {
  words: WordList | WordList[] | Iterable<string>;
  cpm?: number;
  thinkMs?: [number, number];
  learn?: boolean;
  forgetInvalid?: boolean;
  attempts?: number;
  pickLanguage?: boolean;
}

const PLAYABLE_MODES = new Set([0, 1]);

const rand = (min: number, max: number) => min + Math.random() * (max - min);

const localeKey = (locale: string) => locale.toLowerCase();

const isList = (value: unknown): value is WordList => value instanceof WordList;

function pick(words: string[]): string | undefined {
  let total = 0;
  const weights = words.map((w) => {
    const weight = 1 / Math.pow(w.length, 1.6);
    total += weight;
    return weight;
  });
  let r = Math.random() * total;
  for (let i = 0; i < words.length; i++) {
    r -= weights[i] ?? 0;
    if (r <= 0) return words[i];
  }
  return words[words.length - 1];
}

function toLists(words: AutoplayOptions["words"], locale: string): WordList[] {
  if (words instanceof WordList) return [words];
  const items = [...words];
  const lists = items.filter(isList);
  if (lists.length && lists.length === items.length) return lists;
  return [new WordList(items.filter((w): w is string => typeof w === "string"), locale)];
}

export class Autoplayer {
  readonly lists = new Map<string, WordList>();
  cpm: number;
  private readonly offs: Array<() => void>;
  private running = true;
  private syncing = false;

  constructor(
    readonly room: GameRoom,
    private readonly opts: AutoplayOptions,
  ) {
    for (const list of toLists(opts.words, room.myLocale)) this.lists.set(localeKey(list.locale), list);
    this.cpm = opts.cpm ?? 300;
    this.offs = [
      room.on("game.turn", (turn) => {
        this.play(turn).catch((e: unknown) => console.error("[wordbomb] autoplay turn failed:", e));
      }),
      room.on("game.solve", ({ word, mine, player }) => {
        if (!mine && this.opts.learn && player) this.listFor(player.language)?.add(word);
      }),
      room.on("room.settings", () => this.syncLanguage()),
      room.on("room.language", ({ player }) => {
        if (player.isMe) this.syncLanguage();
      }),
      room.on("game.stop", () => this.syncLanguage()),
      room.on("room.closed", () => this.stop()),
    ];
    void room.settled().then(() => this.syncLanguage());
  }

  get isRunning(): boolean {
    return this.running;
  }

  get languages(): string[] {
    return [...this.lists.values()].map((list) => list.locale);
  }

  get canPlay(): boolean {
    return this.lists.has(localeKey(this.room.myLocale));
  }

  listFor(locale: string): WordList | undefined {
    return this.lists.get(localeKey(locale));
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const off of this.offs) off();
  }

  private syncLanguage(): void {
    const room = this.room;
    if (this.syncing || !this.running || this.opts.pickLanguage === false || !room.isOpen || !room.multiLanguage || room.started) return;
    if (this.canPlay) return;
    const want = this.listFor(room.locale)?.locale ?? this.languages[0];
    if (!want) return;
    this.syncing = true;
    room
      .setLanguage(want)
      .catch(() => false)
      .finally(() => {
        this.syncing = false;
      });
  }

  private async play(turn: Turn): Promise<void> {
    if (!this.running || turn.masked || !turn.prompt || !PLAYABLE_MODES.has(turn.mode)) return;
    const list = this.listFor(turn.locale);
    if (!list) return;
    const [min, max] = this.opts.thinkMs ?? [400, 1200];
    await sleep(Math.min(rand(min, max), turn.timeLeftMs() * 0.4));
    const tried = new Set<string>();
    for (let attempt = 0; attempt < (this.opts.attempts ?? 3); attempt++) {
      if (!this.running || !turn.active()) return;
      const options = list.candidates(turn.prompt, { match: turn.match, used: turn.used }).filter((w) => !tried.has(w));
      const word = pick(options);
      if (!word) return;
      tried.add(word);
      if ((word.length * 60000) / this.cpm > turn.timeLeftMs()) return;
      const outcome = await turn.play(word, { cpm: this.cpm });
      if (outcome.ok) return;
      if (outcome.reason === "notAWord" && this.opts.forgetInvalid !== false) list.remove(word);
      if (outcome.reason === "timeout" || outcome.reason === "turnOver" || outcome.reason === "busy" || outcome.reason === "left") return;
    }
  }
}
