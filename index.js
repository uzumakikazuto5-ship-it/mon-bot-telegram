
const { Telegraf } = require("telegraf");
const fs = require("fs");

const BOT_TOKEN = process.env.BOT_TOKEN;
const API_TOKEN = process.env.FOOTBALL_DATA_TOKEN;

if (!BOT_TOKEN || !API_TOKEN) {
  console.error("Configure BOT_TOKEN et FOOTBALL_DATA_TOKEN.");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const STATE_FILE = "./jarvis-state.json";

let state = {
  chats: [],
  dailySent: "",
  reminders: [],
  resultsSent: []
};

try {
  if (fs.existsSync(STATE_FILE)) {
    state = {
      ...state,
      ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
    };
  }
} catch (e) {
  console.error("Erreur de lecture de l'état :", e.message);
}

function save() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function localDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Lome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function localTime(date = new Date()) {
  return date.toLocaleTimeString("fr-FR", {
    timeZone: "Africa/Lome",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let lastApiCall = 0;

async function api(path) {
  const wait = Math.max(0, 6200 - (Date.now() - lastApiCall));
  if (wait) await sleep(wait);
  lastApiCall = Date.now();

  const response = await fetch(
    "https://api.football-data.org/v4" + path,
    { headers: { "X-Auth-Token": API_TOKEN } }
  );

  if (!response.ok) {
    throw new Error("API football : HTTP " + response.status);
  }

  return response.json();
}

async function sendAll(message) {
  for (const chatId of state.chats) {
    try {
      await bot.telegram.sendMessage(chatId, message);
    } catch (e) {
      console.error("Erreur Telegram :", e.message);
    }
  }
}

async function getMatches() {
  const today = localDate();
  const tomorrow = localDate(new Date(Date.now() + 86400000));

  const data = await api(
    `/matches?dateFrom=${today}&dateTo=${tomorrow}`
  );

  return data.matches || [];
}

const historyCache = new Map();

async function teamStats(teamId, forceRefresh = false) {
  const cached = historyCache.get(teamId);

  if (
    !forceRefresh &&
    cached &&
    Date.now() - cached.time < 15 * 60 * 1000
  ) {
    return cached.stats;
  }

  const data = await api(
    `/teams/${teamId}/matches?status=FINISHED&limit=10`
  );

  const matches = (data.matches || [])
    .filter(m =>
      m.status === "FINISHED" &&
      m.score?.fullTime?.home != null &&
      m.score?.fullTime?.away != null
    )
    .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate))
    .slice(0, 10);

  if (matches.length < 3) return null;

  let scored = 0;
  let conceded = 0;

  for (const m of matches) {
    const isHome = m.homeTeam.id === teamId;
    const homeGoals = m.score.fullTime.home;
    const awayGoals = m.score.fullTime.away;

    scored += isHome ? homeGoals : awayGoals;
    conceded += isHome ? awayGoals : homeGoals;
  }

  const stats = {
    played: matches.length,
    scored: scored / matches.length,
    conceded: conceded / matches.length
  };

  historyCache.set(teamId, { time: Date.now(), stats });
  return stats;
}

function poisson(k, lambda) {
  let factorial = 1;
  for (let i = 2; i <= k; i++) factorial *= i;
  return Math.exp(-lambda) * Math.pow(lambda, k) / factorial;
}

function predict(homeLambda, awayLambda) {
  const scores = [];
  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;

  for (let h = 0; h <= 7; h++) {
    for (let a = 0; a <= 7; a++) {
      const p = poisson(h, homeLambda) * poisson(a, awayLambda);
      scores.push({ h, a, p });

      if (h > a) homeWin += p;
      else if (h === a) draw += p;
      else awayWin += p;
    }
  }

  scores.sort((a, b) => b.p - a.p);
  const total = homeWin + draw + awayWin;

  return {
    best: scores[0],
    homeWin: homeWin / total,
    draw: draw / total,
    awayWin: awayWin / total
  };
}

function pct(value) {
  return (value * 100).toFixed(1) + "%";
}

async function analyzeMatch(match) {
  const home = await teamStats(match.homeTeam.id);
  const away = await teamStats(match.awayTeam.id);

  if (!home || !away) {
    return "Données insuffisantes pour calculer une estimation.";
  }

  const homeLambda = Math.max(
    0.15, (home.scored + away.conceded) / 2
  );

  const awayLambda = Math.max(
    0.15, (away.scored + home.conceded) / 2
  );

  const p = predict(homeLambda, awayLambda);

  return (
    `📊 ESTIMATION STATISTIQUE\n\n` +
    `⚽ ${match.homeTeam.name} - ${match.awayTeam.name}\n` +
    `📅 ${localDate(new Date(match.utcDate))} à ` +
    `${localTime(new Date(match.utcDate))} (Togo)\n\n` +
    `Buts attendus selon le modèle :\n` +
    `• ${match.homeTeam.name} : ${homeLambda.toFixed(2)}\n` +
    `• ${match.awayTeam.name} : ${awayLambda.toFixed(2)}\n\n` +
    `Score le plus probable parmi les scores calculés :\n` +
    `• ${match.homeTeam.name} ${p.best.h} - ${p.best.a} ` +
    `${match.awayTeam.name}\n\n` +
    `Probabilités estimées :\n` +
    `• Victoire domicile : ${pct(p.homeWin)}\n` +
    `• Match nul : ${pct(p.draw)}\n` +
    `• Victoire extérieur : ${pct(p.awayWin)}\n\n` +
    `Échantillon : ${home.played} matchs à domicile, ` +
    `${away.played} matchs à l'extérieur.\n\n` +
    `⚠️ Estimation indicative, sans garantie. Le modèle ne tient ` +
    `pas compte des blessures, compositions ou de la force des adversaires.`
  );
}

bot.start(async ctx => {
  if (!state.chats.includes(ctx.chat.id)) {
    state.chats.push(ctx.chat.id);
    save();
  }

  await ctx.reply(
    "JARVIS Football est actif !\n\n" +
    "/start — activer les messages\n" +
    "/ping — tester le bot\n" +
    "/help — aide"
  );
});

bot.command("ping", ctx => ctx.reply("JARVIS est en ligne !"));

bot.help(ctx => ctx.reply(
  "JARVIS : matchs à 6 h, estimations statistiques avant les rencontres " +
  "et scores finaux après les matchs."
));

let busy = false;

async function runChecks() {
  if (busy) return;
  busy = true;

  try {
    const matches = await getMatches();
    const now = Date.now();
    const today = localDate();
    const time = localTime();

    // Envoi entre 06:00 et 06:10, heure du Togo.
    // Cela évite de manquer l'envoi si la vérification est légèrement retardée.
    if (
      time >= "06:00" &&
      time <= "06:10" &&
      state.dailySent !== today
    ) {
      const upcoming = matches
        .filter(m =>
          localDate(new Date(m.utcDate)) === today &&
          ["SCHEDULED", "TIMED"].includes(m.status) &&
          new Date(m.utcDate).getTime() > now
        )
        .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate))
        .slice(0, 10);

      let message = `⚽ JARVIS — MATCHS DU JOUR (${today})\n\n`;

      if (upcoming.length === 0) {
        message +=
          "Aucun match à venir trouvé dans les compétitions accessibles.";
      } else {
        upcoming.forEach((m, i) => {
          message += `${i + 1}. ${m.homeTeam.name} - ${m.awayTeam.name}\n`;
          message += `🏆 ${m.competition?.name || "Compétition"}\n`;
          message += `🕒 ${localTime(new Date(m.utcDate))} (Togo)\n\n`;
        });
      }

      await sendAll(message);
      state.dailySent = today;
      save();
    }

    for (const match of matches) {
      const id = String(match.id);
      const start = new Date(match.utcDate).getTime();
      const minutes = (start - now) / 60000;

      // Estimation dans les 30 minutes avant le match.
      if (
        minutes > 0 &&
        minutes <= 30 &&
        !state.reminders.includes(id)
      ) {
        const analysis = await analyzeMatch(match);

        await sendAll(
          `⏰ MATCH DANS ENVIRON 30 MINUTES\n\n${analysis}`
        );

        state.reminders.push(id);
        save();
      }

      // Score réel après la fin officielle selon l'API.
      if (
        match.status === "FINISHED" &&
        !state.resultsSent.includes(id)
      ) {
        const score = match.score?.fullTime;

        if (score && score.home != null && score.away != null) {
          await sendAll(
            `🏁 SCORE FINAL\n\n${match.homeTeam.name} ` +
            `${score.home} - ${score.away} ${match.awayTeam.name}`
          );

          state.resultsSent.push(id);
          save();
        }
      }
    }
  } catch (e) {
    console.error("Vérification :", e.message);
  } finally {
    busy = false;
  }
}

bot.launch()
  .then(() => console.log("JARVIS démarré."))
  .catch(e => console.error("Erreur Telegram :", e.message));

setInterval(runChecks, 60000);
runChecks();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
