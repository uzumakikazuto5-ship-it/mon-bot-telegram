
const { Telegraf } = require("telegraf");

const token = process.env.BOT_TOKEN;

if (!token) {
  console.error("La variable BOT_TOKEN est manquante.");
  process.exit(1);
}

const bot = new Telegraf(token);

bot.start((ctx) =>
  ctx.reply(
    "Bonjour ! JARVIS est actif.\n" +
    "Commandes disponibles : /start, /help, /ping"
  )
);

bot.help((ctx) =>
  ctx.reply("JARVIS est prêt. La fonction football sera ajoutée ensuite.")
);

bot.command("ping", (ctx) => ctx.reply("JARVIS est en ligne !"));

bot.launch()
  .then(() => console.log("JARVIS a démarré."))
  .catch((error) => console.error("Erreur au démarrage :", error));

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
