import { modeName, WordBomb, type BotEmbed, type GameRoom } from "../src/index.js";

const key = process.env.WORDBOMB_BOT_KEY;
const target = process.env.WORDBOMB_TARGET === "local" ? "local" : "prod";
if (!key) {
  console.error("set WORDBOMB_BOT_KEY, then: npm run example:tracker <room id>");
  process.exit(1);
}

interface Tally {
  name: string;
  words: number;
  longest: string;
}

interface MatchStats {
  correct_words?: number;
  wpm?: number;
  win?: boolean;
}

interface MatchRow {
  match?: { winner?: string; stats?: Record<string, MatchStats | undefined> };
}

const games = new Map<string, Map<string, Tally>>();

function summary(room: GameRoom, podium: Array<{ place: number; name: string }>): BotEmbed {
  const tallies = [...(games.get(room.id)?.values() ?? [])].sort((a, b) => b.words - a.words);
  const longest = tallies.reduce<Tally | null>((best, t) => (!best || t.longest.length > best.longest.length ? t : best), null);
  return {
    title: "Game over",
    description: podium.slice(0, 3).map((p) => `${p.place}. ${p.name}`).join("\n") || "nobody placed",
    fields: [
      { name: "Most words", value: tallies.slice(0, 3).map((t) => `${t.name}: ${t.words}`).join("\n") || "none", inline: true },
      { name: "Longest word", value: longest?.longest ? `${longest.longest} by ${longest.name}` : "none", inline: true },
    ],
    footer: { text: `${modeName(room.mode)}, ${room.locale}` },
  };
}

const bot = await WordBomb.connect({ key, target });
await bot.commands.set([
  { name: "stats", description: "Recent games of a player in this room", options: [{ name: "player", description: "Who to look up", type: "player", required: true }] },
]);
console.log(`logged in as ${bot.me.name}`);

bot.on("game.start", ({ room }) => games.set(room.id, new Map()));

bot.on("game.solve", ({ room, player, word }) => {
  if (!player) return;
  const tally = games.get(room.id);
  if (!tally) return;
  const t = tally.get(player.sessionId) ?? { name: player.name, words: 0, longest: "" };
  t.words++;
  if (word.length > t.longest.length) t.longest = word;
  tally.set(player.sessionId, t);
});

bot.on("game.end", ({ room, podium }) => {
  room.post({ embed: summary(room, podium) }).catch((e: Error) => console.log(`${room.id}: summary not posted: ${e.message}`));
  games.delete(room.id);
});

bot.on("command", async (cmd) => {
  if (cmd.name !== "stats") return;
  const who = cmd.player("player");
  if (!who || who.isGuest) {
    await cmd.reply({ text: "pick a registered player in this room", ephemeral: true });
    return;
  }
  try {
    const history = await bot.http.get<{ matches?: MatchRow[] }>("player", `/match/history?playerId=${encodeURIComponent(who.id)}&limit=10&minimal=true`);
    const matches = history.matches ?? [];
    let wins = 0;
    let words = 0;
    let bestWpm = 0;
    for (const row of matches) {
      const stats = row.match?.stats?.[who.id];
      if (stats?.win || row.match?.winner === who.id) wins++;
      words += stats?.correct_words ?? 0;
      bestWpm = Math.max(bestWpm, Math.round(stats?.wpm ?? 0));
    }
    await cmd.reply({
      embed: {
        title: `${who.name}, last ${matches.length} games`,
        fields: [
          { name: "Wins", value: String(wins), inline: true },
          { name: "Words a game", value: matches.length ? (words / matches.length).toFixed(1) : "0", inline: true },
          { name: "Best WPM", value: String(bestWpm), inline: true },
        ],
      },
    });
  } catch (e) {
    await cmd.reply({ text: `couldn't load their games: ${e instanceof Error ? e.message : String(e)}`, ephemeral: true });
  }
});

bot.on("friend.request", (request) => void request.accept());

bot.on("invite.received", (invite) => {
  if (!invite.roomId) return;
  bot.rooms.join(invite.roomId, { spectate: true }).catch((e: Error) => console.log(`could not join ${invite.roomId}: ${e.message}`));
});

bot.on("room.closed", ({ room }) => games.delete(room.id));

bot.on("error", (e) => console.error(e.message));

const roomId = process.argv[2];
if (roomId) await bot.rooms.join(roomId, { spectate: true });
console.log("spectating; invite me to more rooms and I'll watch those too");
