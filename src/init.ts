import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { VERSION } from "./version.js";

const BOT_TS = `import { WordBomb, WordList } from "@wordbombio/sdk";

const key = process.env.WORDBOMB_BOT_KEY;
const target = process.env.WORDBOMB_TARGET === "local" ? "local" : "prod";
if (!key) throw new Error("put WORDBOMB_BOT_KEY in .env (create a key at https://wordbomb.io/bots)");

const spec = process.env.WORDBOMB_WORDS;
const words = spec ? await WordList.fromSpec(spec) : [new WordList(["HELLO", "WORLD", "BOMB", "WORD"])];

const bot = await WordBomb.connect({ key, target, locale: words[0]?.locale });
console.log(\`logged in as \${bot.me.name}\`);

bot.on("dm.message", async (message) => {
  if (message.text) await message.reply(\`hi \${message.from.name}, you said: \${message.text}\`);
});

bot.on("friend.request", (request) => request.accept());

bot.on("invite.received", (invite) => {
  if (invite.roomId) invite.join().catch((e) => console.error(e.message));
});

await bot.commands.set([{ name: "ping", description: "Check that the bot is awake" }]);

bot.on("command", (cmd) => {
  if (cmd.name === "ping") void cmd.reply({ text: "pong" });
});

bot.on("room.joined", ({ room }) => {
  console.log(\`joined room \${room.id}\`);
  room.autoplay({ words, cpm: 300, learn: true });
});

bot.on("error", (e) => console.error(e.message));

await bot.rooms.create({ mode: 0, private: false });
`;

const ENV_EXAMPLE = `WORDBOMB_BOT_KEY=
WORDBOMB_TARGET=prod
WORDBOMB_LOCALE=en-US
# one word list per language you play, one word per line: en-US=./en.txt,tr-TR=./tr.txt
WORDBOMB_WORDS=
`;

const AGENTS_POINTER = `
## Word Bomb bot

This project is a Word Bomb bot built on \`@wordbombio/sdk\`. Before changing bot code, read \`node_modules/@wordbombio/sdk/AGENTS.md\`: it explains the API, every event name, the rules bots must follow and how to run things. The \`wordbomb\` MCP server in \`.mcp.json\` lets you drive the bot account directly.
`;

const PACKAGE_JSON = {
  name: "my-wordbomb-bot",
  private: true,
  type: "module",
  scripts: { start: "node --env-file-if-exists=.env --import tsx bot.ts" },
  dependencies: { "@wordbombio/sdk": `^${VERSION}` },
  devDependencies: { tsx: "^4.19.2" },
};

const MCP_SERVER = {
  command: "npx",
  args: ["-y", "@wordbombio/sdk", "mcp"],
};

async function writeIfMissing(file: string, content: string, log: string[]): Promise<void> {
  if (existsSync(file)) {
    log.push(`kept ${file} (already exists)`);
    return;
  }
  await writeFile(file, content);
  log.push(`wrote ${file}`);
}

async function mergeMcp(file: string, log: string[]): Promise<void> {
  let config: { mcpServers?: Record<string, unknown> } = {};
  if (existsSync(file)) {
    try {
      config = JSON.parse(await readFile(file, "utf8"));
    } catch {
      log.push(`kept ${file} (not valid JSON, add the wordbomb server by hand)`);
      return;
    }
  }
  const servers = config.mcpServers ?? {};
  if (servers.wordbomb) {
    log.push(`kept ${file} (wordbomb server already there)`);
    return;
  }
  config.mcpServers = { ...servers, wordbomb: MCP_SERVER };
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
  log.push(`added the wordbomb MCP server to ${file}`);
}

async function append(file: string, content: string, log: string[]): Promise<void> {
  const current = existsSync(file) ? await readFile(file, "utf8") : "";
  await appendFile(file, current && !current.endsWith("\n") ? `\n${content}` : content);
  log.push(`${current ? "updated" : "wrote"} ${file}`);
}

async function ignore(file: string, entries: string[], log: string[]): Promise<void> {
  const current = existsSync(file) ? await readFile(file, "utf8") : "";
  const lines = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const missing = entries.filter((e) => !lines.has(e) && !lines.has(`/${e}`));
  if (!missing.length) {
    log.push(`kept ${file} (already ignores ${entries.join(" and ")})`);
    return;
  }
  await append(file, `${missing.join("\n")}\n`, log);
}

async function pointAgents(file: string, log: string[]): Promise<void> {
  const current = existsSync(file) ? await readFile(file, "utf8") : "";
  if (current.includes("@wordbombio/sdk")) {
    log.push(`kept ${file} (already points at @wordbombio/sdk)`);
    return;
  }
  await append(file, AGENTS_POINTER.trimStart(), log);
}

export async function init(dir: string): Promise<string> {
  const root = resolve(dir);
  await mkdir(root, { recursive: true });
  const log: string[] = [];
  await writeIfMissing(join(root, "package.json"), `${JSON.stringify(PACKAGE_JSON, null, 2)}\n`, log);
  await writeIfMissing(join(root, "bot.ts"), BOT_TS, log);
  await writeIfMissing(join(root, ".env.example"), ENV_EXAMPLE, log);
  await writeIfMissing(join(root, ".env"), ENV_EXAMPLE, log);
  await ignore(join(root, ".gitignore"), ["node_modules", ".env"], log);
  await mergeMcp(join(root, ".mcp.json"), log);
  await pointAgents(join(root, "AGENTS.md"), log);
  return [
    ...log,
    "",
    "next:",
    "  1. create a bot at https://wordbomb.io/bots and paste its key into .env",
    "  2. npm install",
    "  3. npm start",
    "agents: the wordbomb MCP server in .mcp.json reads the same .env from this folder",
  ].join("\n");
}
