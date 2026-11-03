import { WordBomb, WordList, type GameRoom } from "../src/index.js";

const key = process.env.WORDBOMB_BOT_KEY;
const target = process.env.WORDBOMB_TARGET === "local" ? "local" : "prod";
const spec = process.env.WORDBOMB_WORDS;
if (!key || !spec) {
  console.error("set WORDBOMB_BOT_KEY and WORDBOMB_WORDS (one list per language: en-US=./en.txt,tr-TR=./tr.txt), then: npm run example [room id]");
  process.exit(1);
}

const lists = await WordList.fromSpec(spec);
const speaks = lists.map((list) => list.locale);
const bot = await WordBomb.connect({ key, target, locale: speaks[0] });
console.log(`logged in as ${bot.me.name}, plays ${lists.map((l) => `${l.locale} (${l.size} words)`).join(", ")}`);

function describe(room: GameRoom): string {
  const c = room.config;
  const language = c.multiLanguage ? `multi-language, I play ${room.myLocale}` : c.language;
  return `${room.id}: mode ${c.mode}, ${language}, ${c.hearts} hearts, ${room.players.length} players`;
}

function checkLanguage(room: GameRoom): void {
  const c = room.config;
  if (c.multiLanguage || speaks.includes(c.language)) return;
  room.say(`I only play ${speaks.join(", ")}. Switch the room language or turn on multi-language and I'll join in.`);
}

bot.on("friend.request", (request) => {
  console.log(`friend request from ${request.from.name}, accepting`);
  void request.accept();
});

bot.on("invite.received", (invite) => {
  if (!invite.roomId) return;
  console.log(`${invite.from.name} invited me to ${invite.roomId}`);
  invite.join().catch((e: Error) => console.log(`could not join ${invite.roomId}: ${e.message}`));
});

bot.on("room.joined", ({ room }) => {
  room.autoplay({ words: lists, cpm: 350, learn: true });
});

bot.on("room.ready", ({ room }) => {
  console.log(`joined ${describe(room)} (in ${bot.rooms.all.length} rooms now)`);
  checkLanguage(room);
});

bot.on("room.settings", ({ room }) => {
  console.log(`settings changed in ${describe(room)}`);
  checkLanguage(room);
});

bot.on("room.language", ({ room, player }) => {
  if (player.isMe) console.log(`${room.id}: I play ${player.language} now`);
});

bot.on("chat.message", (m) => {
  const text = m.text.trim();
  if (text === "!lang") {
    m.reply(`I play ${m.room.myLocale} here and know ${speaks.join(", ")}`);
    return;
  }
  if (!text.startsWith("!lang ")) return;
  const want = text.slice(6).trim();
  if (!m.room.multiLanguage) m.reply("this room isn't multi-language, the host picks the language");
  else if (!speaks.includes(want)) m.reply(`I don't have words for ${want}`);
  else if (m.room.started) m.reply("I can switch after this game");
  else void m.room.setLanguage(want).then((ok) => m.reply(ok ? `switched to ${want}` : `couldn't switch to ${want}`));
});

bot.on("game.miss", ({ room, word, reason, mine }) => {
  if (mine) console.log(`${room.id}: missed ${word} (${reason})`);
});

bot.on("game.end", ({ room, myPlace }) => console.log(`${room.id}: game over, placed ${myPlace ?? "-"}`));

bot.on("room.closed", ({ room, reason }) => console.log(`${room.id}: left (${reason})`));

bot.on("error", (e) => console.error(e.message));

const roomId = process.argv[2];
if (roomId) await bot.rooms.join(roomId);
else await bot.rooms.create({ mode: 0, multiLanguage: speaks.length > 1, language: speaks[0] });
console.log("waiting for friends and invites; every invite joins another room");
