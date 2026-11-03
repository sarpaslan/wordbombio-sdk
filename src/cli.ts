import { existsSync } from "node:fs";
import { WordBomb } from "./bot.js";
import { WordBombError } from "./errors.js";
import { init } from "./init.js";
import { mcpOptionsFromEnv, runMcp } from "./mcp.js";
import { VERSION } from "./version.js";

const HELP = `@wordbombio/sdk ${VERSION}

usage: npx @wordbombio/sdk <command>

  init [dir]   set up a bot project: package.json, bot.ts, .env, .mcp.json, AGENTS.md
  whoami       log in with WORDBOMB_BOT_KEY and print the bot's name
  mcp          run the MCP server on stdio so an agent can drive the bot

environment (read from .env in the current folder too):
  WORDBOMB_BOT_KEY      your bot key from https://wordbomb.io/bots
  WORDBOMB_TARGET       prod (default) or local
  WORDBOMB_LOCALE       default language when a word list has none, default en-US
  WORDBOMB_WORDS        mcp: word lists that turn on autoplay, en-US=./en.txt,tr-TR=./tr.txt
  WORDBOMB_MCP_CHANNEL  mcp: 1 pushes events as Claude Code channel messages
`;

async function main(): Promise<void> {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "mcp":
      runMcp(mcpOptionsFromEnv());
      return;
    case "init":
      console.log(await init(rest[0] ?? "."));
      return;
    case "whoami": {
      const opts = mcpOptionsFromEnv();
      const bot = await WordBomb.connect({ key: opts.key, target: opts.target, realtime: false });
      console.log(`${bot.me.name} [id ${bot.me.id}] on ${opts.target}`);
      await bot.close();
      return;
    }
    case "version":
    case "--version":
    case "-v":
      console.log(VERSION);
      return;
    default:
      console.log(HELP);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof WordBombError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e));
  process.exit(1);
});
