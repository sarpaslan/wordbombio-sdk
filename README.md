# @wordbombio/sdk

Build official bots and applications for [Word Bomb](https://wordbomb.io). A bot key logs your bot in, and the package handles rooms, turns, chat, slash commands, embeds and buttons, DMs, friends, comments, notifications, avatars and cosmetics. It also ships an MCP server, so an AI agent can play too.

```sh
npx @wordbombio/sdk init my-bot
cd my-bot
# paste your key from the Bots tab at https://wordbomb.io/bots into .env
npm install
npm start
```

```ts
import { WordBomb } from "@wordbombio/sdk";

const bot = await WordBomb.connect({ key: process.env.WORDBOMB_BOT_KEY!, target: "prod" });

bot.on("dm.message", (m) => m.reply(`hi ${m.from.name}!`));

await bot.commands.set([{ name: "ping", description: "Check that I'm awake" }]);
bot.on("command", (cmd) => cmd.reply({ embed: { title: "pong" } }));

bot.on("game.turn", async (turn) => {
  const word = myWords.find((w) => turn.matches(w));
  if (word) await turn.play(word, { cpm: 350 });
});

await bot.rooms.create({ mode: 0 });
await bot.avatar.upload("avatar.png");
```

There are two kinds of account. A **bot** is a player: it joins rooms, plays and talks. An **application** is a plugin: players install it, and it never joins a room.

## What bots can do

**Rooms and playing**
- Join any room whose host allows bot accounts (off by default), and create their own rooms, which always allow them.
- Sit in up to 10 rooms at once, never twice in the same room.
- Play turns, by hand or with autoplay, in each room's language. In multi-language rooms they pick their own.
- Spectate instead of playing.
- Host the rooms they create, or inherit host when no human is left: start and end games, change settings and the title, kick, ban and hand over host.
- Come back by themselves after a dropped connection or a Word Bomb server restart.

**Chat, commands and posts**
- Read and send room chat, whisper and send love.
- Define up to 25 slash commands that players run from room chat, with typed options (text, numbers, players, choices).
- Answer commands and button presses with text, embeds and buttons, for everyone or ephemeral (only the player who asked sees it).
- Post their own messages and embeds into rooms they're in, like game summaries or trackers.
- Edit their own messages in place when someone presses one of its buttons.

**Live game events**
- See everything the room shows a player: players, hosts, settings, turns, prompts, every solve and miss, hurts, eliminations, chat and game results.

**People**
- DM their friends and anyone who messaged them first.
- Accept or decline friend requests, and remove friends.
- Invite friends to their rooms.
- Comment on friends' profiles and reply to comments.
- Get notifications for comments, replies, achievements and gifts.
- Edit their profile: display name, about me, avatar, banner and game background.

**Reading**
- Public profiles, match history, single matches, achievements and rank history.

**Progression**
- Earn XP, levels, achievements, coins and items like anyone, and wear the cosmetics they own: bombs, hearts, ghosts, streaks, letters, explosions and combos.
- Show up in match history.

## What applications can do

**Rooms**
- Never join, create, spectate or host a room.
- Get an app room for every room one of their installers is in, for as long as an installer is there and the app is online.
- Each app room only reaches the room's installers. Other players never see the app.

**Live game events**
- Get a server-truth stream from each app room: players (with hearts and who's spectating), joins and leaves, turns and prompts, every accepted and rejected word, hurts, eliminations, and game start and end. It comes from the game server itself, so installers can't fake it.
- Never get chat, whispers or typing.
- Get the same event objects a bot gets, so tracker code works for both.

**Commands and posts**
- Define slash commands like bots. Only players who installed the app see them and can run them.
- Answer with text, embeds and buttons, ephemeral or not, and post into app rooms. Only the room's installers see any of it.

**People**
- DM players who installed them, and anyone who messaged them first.
- Send in-game notifications to players who installed them. Never to Discord.
- Edit their profile: display name, about me, avatar, banner and background.

**Reading**
- Public profiles, match history, single matches, achievements and rank history.

**Progression**
- None. Apps never play, so they earn no XP, levels, coins or items, and wear no cosmetics.

## What neither can do

- Play ranked, placement, tournaments or event rooms. These rooms get no bot commands, posts or app streams either.
- Appear on any leaderboard, or earn WP, season XP or clan XP.
- Get word discoveries or claims, or do categories.
- Gift, or use the shop, the market or giveaways.
- Send friend requests. Players add bots and install apps; a bot or app never reaches out first.
- Use group chats (applications). Nobody can add an app to one.
- Use `/i` or `/syl`, which look words up in the dictionary.
- Run while an admin has bots switched off (the kill switch). Logging in throws `BOTS_DISABLED`, room joins are refused and seated bots are kicked (`BOTS_NOT_ALLOWED`), and app rooms get no events until it's back on. Try again later.

A brand new account can't send DMs or use chat commands for its first 24 hours. Both kinds always show a bot badge, and a banned owner, or one who loses the Bot Developer role, takes every key down with them.

## Acceptable use

The code is MIT licensed. Using it with Word Bomb also means following the [Terms of Service](https://legal.wordbomb.io/terms) and these rules. Breaking them gets the bot's key reset and the bot banned, and the developer's account banned along with every bot it owns.

Not allowed:

- Cheats or anything that helps a player win: solvers, word finders, hint or answer tools, auto typers, or anything that plays for a human account.
- Sending live prompts, answers or hints to players during a game, in the game or anywhere else.
- Logging in human accounts through the package, or sharing, selling or trading bot keys.
- Spam: unwanted DMs, mass invites, or flooding rooms with posts or commands.
- Collecting player data beyond what the bot needs, or selling or publishing it.
- Pretending to be staff, another player or another bot.
- Getting around bans, rate limits, consent rules or the bot kill switch.

Good uses: bots that play fair in rooms that allow bots, chat bots, game trackers and stat bots for players who add them, and fun commands.

## Rate limits

Per bot or app account:

| | |
|---|---|
| HTTP requests | 120 a minute in all |
| Room joins / room creations | 10 / 5 a minute (bots) |
| DMs | 30 a minute |
| Profile comments | 10 per 5 minutes (bots) |
| Invites | 6 a minute (bots) |
| Unprompted posts | 6 a minute per room |
| Answers | one reply or update per command or button press, within 14 seconds |
| Notifications | 1 per player a minute, 600 a day (apps) |

Players can run your commands and press your buttons 8 times per 10 seconds each. Going over a limit throws `RATE_LIMITED` (or `JOIN_TOO_FAST` for joins), with `retryAfterMs` when the server says how long to wait. The package checks the post and answer limits itself before sending, and checks command definitions and embeds before anything leaves.

## Getting a key

Keys come from the Bots tab at https://wordbomb.io/bots, where you pick a bot or an application. Creating them needs the Bot Developer role. Each one is its own account with its own name, avatar and about me. `bot.kind` tells your code which kind it logged in as.

Players add a bot as a friend and invite it to their rooms. Players install an application from its profile.

Everything a bot or app receives arrives on one live connection, and everything it does goes out over the services' normal HTTP routes, so there's nothing to poll.

## Examples

| | |
|---|---|
| `examples/autoplayer.ts` | Plays turns in several languages and follows invites. |
| `examples/chatbot.ts` | Slash commands with embed replies and a button poll. |
| `examples/tracker.ts` | Spectates, posts a summary embed after each game, answers `/stats <player>` from match history. |
| `examples/hyphen-champion.ts` | An application that counts hyphenated words across every room its installers play in. |

## Agents

- [AGENTS.md](./AGENTS.md) is the full reference: every event, method, error and rule. Coding agents should read it first.
- `npx @wordbombio/sdk mcp` runs an MCP server for the bot. Add it with:

```sh
claude mcp add wordbomb -e WORDBOMB_BOT_KEY=wbb_... -- npx -y @wordbombio/sdk mcp
```

## CLI

| Command | |
|---|---|
| `npx @wordbombio/sdk init [dir]` | Scaffold a bot project. |
| `npx @wordbombio/sdk whoami` | Check your key. |
| `npx @wordbombio/sdk mcp` | Run the MCP server on stdio. |
