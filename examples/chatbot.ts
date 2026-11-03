import { WordBomb, type BotEmbed, type CommandDef } from "../src/index.js";

const key = process.env.WORDBOMB_BOT_KEY;
const target = process.env.WORDBOMB_TARGET === "local" ? "local" : "prod";
if (!key) {
  console.error("set WORDBOMB_BOT_KEY, then: npm run example:chat [room id]");
  process.exit(1);
}

const commands: CommandDef[] = [
  { name: "help", description: "What I can do" },
  { name: "roll", description: "Roll a die", options: [{ name: "sides", description: "How many sides, 6 if you leave it out", type: "number" }] },
  { name: "hug", description: "Send someone a hug", options: [{ name: "who", description: "Who gets it", type: "player", required: true }] },
  { name: "poll", description: "Ask the room a yes or no question", options: [{ name: "question", description: "The question", type: "message", required: true }] },
];

interface Poll {
  question: string;
  by: string;
  votes: Map<string, "yes" | "no">;
  closed: boolean;
}

const polls = new Map<string, Poll>();

function pollEmbed(poll: Poll): BotEmbed {
  let yes = 0;
  for (const vote of poll.votes.values()) if (vote === "yes") yes++;
  const no = poll.votes.size - yes;
  return {
    title: poll.question,
    fields: [
      { name: "Yes", value: String(yes), inline: true },
      { name: "No", value: String(no), inline: true },
    ],
    footer: { text: poll.closed ? "poll closed" : "vote with the buttons, the asker closes it" },
    components: [
      {
        components: [
          { style: 3, label: "Yes", custom_id: "yes", disabled: poll.closed },
          { style: 4, label: "No", custom_id: "no", disabled: poll.closed },
          { style: 2, label: "Close", custom_id: "close", disabled: poll.closed },
        ],
      },
    ],
  };
}

const bot = await WordBomb.connect({ key, target });
const version = await bot.commands.set(commands);
console.log(`logged in as ${bot.me.name}, commands v${version}`);

bot.on("command", async (cmd) => {
  switch (cmd.name) {
    case "help":
      await cmd.reply({
        ephemeral: true,
        embed: {
          title: `${bot.me.name} commands`,
          fields: bot.commands.all.map((c) => ({ name: `/${c.name}`, value: c.description })),
        },
      });
      return;
    case "roll": {
      const sides = Math.min(Math.max(Math.round(cmd.number("sides") ?? 6), 2), 1000);
      await cmd.reply({ text: `${cmd.user.name} rolled ${1 + Math.floor(Math.random() * sides)} (d${sides})` });
      return;
    }
    case "hug": {
      const who = cmd.player("who");
      if (!who) {
        await cmd.reply({ text: "I can't find them in this room", ephemeral: true });
        return;
      }
      await cmd.reply({ text: `${cmd.user.name} hugs ${who.name}` });
      return;
    }
    case "poll": {
      const poll: Poll = { question: cmd.string("question") ?? "?", by: cmd.user.id, votes: new Map(), closed: false };
      const messageId = await cmd.reply({ embed: pollEmbed(poll) });
      polls.set(messageId, poll);
      if (polls.size > 100) {
        const oldest = polls.keys().next().value;
        if (oldest !== undefined) polls.delete(oldest);
      }
      return;
    }
  }
});

bot.on("button", async (btn) => {
  const poll = polls.get(btn.messageId);
  if (!poll || poll.closed) {
    await btn.reply({ text: "that poll is over", ephemeral: true });
    return;
  }
  if (btn.customId === "close") {
    if (btn.user.id !== poll.by) {
      await btn.reply({ text: "only the asker can close it", ephemeral: true });
      return;
    }
    poll.closed = true;
    polls.delete(btn.messageId);
  } else if (btn.customId === "yes" || btn.customId === "no") {
    poll.votes.set(btn.user.id, btn.customId);
  }
  await btn.update({ embed: pollEmbed(poll) });
});

bot.on("friend.request", (request) => void request.accept());

bot.on("invite.received", (invite) => {
  if (invite.roomId) invite.join().catch((e: Error) => console.log(`could not join ${invite.roomId}: ${e.message}`));
});

bot.on("room.ready", ({ room }) => console.log(`in ${room.id}, ${room.players.length} players`));

bot.on("error", (e) => console.error(e.message));

const roomId = process.argv[2];
if (roomId) await bot.rooms.join(roomId, { spectate: true });
else await bot.rooms.create({ mode: 0 });
console.log("try /help, /roll, /hug and /poll in room chat");
