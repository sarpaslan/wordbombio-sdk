import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { WordBomb, type AnyRoom, type BotEmbed, type GameEnd, type Solve } from "../src/index.js";

const key = process.env.WORDBOMB_BOT_KEY;
const target = process.env.WORDBOMB_TARGET === "local" ? "local" : "prod";
const SAVE = "./hyphen-champion.json";

if (!key) {
  console.error("set WORDBOMB_BOT_KEY to an application key, then: npm run example:hyphens");
  process.exit(1);
}

interface Champion {
  name: string;
  count: number;
  longest: string;
}

const records = new Map<string, Champion>(existsSync(SAVE) ? Object.entries(JSON.parse(await readFile(SAVE, "utf8")) as { [id: string]: Champion }) : []);
const thisGame = new Map<string, Map<string, number>>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function save(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeFile(SAVE, JSON.stringify(Object.fromEntries(records))).catch((e: Error) => console.error(`save failed: ${e.message}`));
  }, 5000);
}

function board(): BotEmbed {
  const top = [...records.values()].sort((a, b) => b.count - a.count).slice(0, 10);
  return {
    title: "Hyphen champions",
    description: top.map((r, i) => `${i + 1}. ${r.name}: ${r.count}`).join("\n") || "nobody has played a hyphenated word yet",
  };
}

function onSolve({ room, player, word }: Solve<AnyRoom>): void {
  if (!player || player.isGuest || !word.includes("-")) return;
  const r = records.get(player.id) ?? { name: player.name, count: 0, longest: "" };
  r.name = player.name;
  r.count++;
  if (word.length > r.longest.length) r.longest = word;
  records.set(player.id, r);
  const game = thisGame.get(room.id) ?? new Map<string, number>();
  game.set(player.id, (game.get(player.id) ?? 0) + 1);
  thisGame.set(room.id, game);
  save();
}

function onEnd({ room }: GameEnd<AnyRoom>): void {
  const game = thisGame.get(room.id);
  thisGame.delete(room.id);
  if (!game?.size) return;
  const [id, count] = [...game.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
  const r = records.get(id);
  if (!r) return;
  room
    .post({ embed: { title: `${r.name} is this game's hyphen champion`, description: `${count} hyphenated words this game, ${r.count} in all. Longest: ${r.longest}` } })
    .catch((e: Error) => console.log(`${room.id}: not posted: ${e.message}`));
}

const bot = await WordBomb.connect({ key, target });
if (bot.kind !== "app") {
  console.error(`${bot.me.name} is a bot account. Create an application in the Bots tab and use its key.`);
  await bot.close();
  process.exit(1);
}
await bot.commands.set([
  { name: "hyphens", description: "Hyphenated word counts", options: [{ name: "player", description: "Whose count, the top 10 if you leave it out", type: "player" }] },
]);
console.log(`logged in as the application ${bot.me.name}, ${records.size} players on record`);

bot.apps.on("room.open", ({ room }) => console.log(`watching ${room.id}`));
bot.apps.on("room.close", ({ room }) => {
  thisGame.delete(room.id);
  console.log(`stopped watching ${room.id}`);
});
bot.apps.on("game.solve", onSolve);
bot.apps.on("game.end", onEnd);

bot.apps.on("command", async (cmd) => {
  if (cmd.name !== "hyphens") return;
  const who = cmd.player("player");
  if (!who) {
    await cmd.reply({ embed: board() });
    return;
  }
  const r = records.get(who.id);
  await cmd.reply({ text: r ? `${r.name}: ${r.count} hyphenated words, longest ${r.longest}` : `${who.name} hasn't played a hyphenated word yet` });
});

bot.on("error", (e) => console.error(e.message));
