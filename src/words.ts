import { readFile } from "node:fs/promises";

export interface CandidateOptions {
  match?: "contains" | "startsWith";
  used?: ReadonlySet<string>;
  minLength?: number;
}

export class WordList {
  private readonly words = new Set<string>();

  constructor(
    words: Iterable<string> = [],
    readonly locale = "en-US",
  ) {
    for (const w of words) this.add(w);
  }

  static async fromFile(path: string, locale = "en-US"): Promise<WordList> {
    const text = await readFile(path, "utf8");
    return new WordList(text.split(/\r?\n/), locale);
  }

  static fromSpec(spec: string, defaultLocale = "en-US"): Promise<WordList[]> {
    const parts = spec
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    return Promise.all(
      parts.map((part) => {
        const eq = part.indexOf("=");
        return eq > 0 ? WordList.fromFile(part.slice(eq + 1).trim(), part.slice(0, eq).trim()) : WordList.fromFile(part, defaultLocale);
      }),
    );
  }

  get size(): number {
    return this.words.size;
  }

  normalize(word: string): string {
    return word.trim().toLocaleUpperCase(this.locale);
  }

  add(word: string): boolean {
    const w = this.normalize(word);
    if (w.length < 2 || this.words.has(w)) return false;
    this.words.add(w);
    return true;
  }

  remove(word: string): boolean {
    return this.words.delete(this.normalize(word));
  }

  has(word: string): boolean {
    return this.words.has(this.normalize(word));
  }

  candidates(prompt: string, opts: CandidateOptions = {}): string[] {
    const p = this.normalize(prompt);
    const min = opts.minLength ?? 3;
    const out: string[] = [];
    for (const w of this.words) {
      if (w.length < min || opts.used?.has(w)) continue;
      if (opts.match === "startsWith" ? w.startsWith(p) : w.includes(p)) out.push(w);
    }
    return out;
  }
}
