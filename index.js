const { Telegraf } = require("telegraf");
const fs = require("fs");

const BOT_TOKEN = process.env.BOT_TOKEN;
const API_TOKEN = process.env.FOOTBALL_DATA_TOKEN;
const CHAT_ID = process.env.CHAT_ID; // optionnel : ton identifiant Telegram

if (!BOT_TOKEN || !API_TOKEN) {
  console.error("Configure BOT_TOKEN et FOOTBALL_DATA_TOKEN.");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const STATE_FILE = "./jarvis-state.json";
const MAX_HISTORY = 500;

// Nombre minimum de buts dans le score prédit (mets 0 pour revenir au score normal)
const MIN_GOALS = 2;

// Heure d'envoi automatique du bilan du jour (heure du Togo)
const BILAN_FROM = "22:00";
const BILAN_TO = "22:10";

const emptyDaily = () => ({
  date: "",
  total: 0,
  outcomeOk: 0,
  exactOk: 0,
  minGoalsOk: 0
});

let state = {
  chats: [],
  dailySent: "",
  bilanSent: "",
  reminders: [],
  resultsSent: [],
  predictions: {},
  stats: { total: 0, outcomeOk: 0, exactOk: 0, minGoalsOk: 0 },
  daily: emptyDaily()
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

// Chat configuré par variable d'environnement : actif sans aucune commande
if (CHAT_ID) {
  const id = Number(CHAT_ID);
  if (Number.isFinite(id) && !state.chats.includes(id)) {
    state.chats.push(id);
  }
}

function save() {
  state.reminders = state.reminders.slice(-MAX_HISTORY);
  state.resultsSent = state.resultsSent.slice(-MAX_HISTORY);

  const keys = Object.keys(state.predictions);
  if (keys.length > MAX_HISTORY) {
    for (const k of keys.slice(0, keys.length - MAX_HISTORY)) {
      delete state.predictions[k];
    }
  }

  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
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

async function apiRequest(path) {
  const wait = Math.max(0, 6200 - (Date.now() - lastApiCall));
  if (wait) await sleep(wait);
  lastApiCall = Date.now();

  const response = await fetch(
    "https://api.football-data.org/v4" + path,
    { headers: { "X-Auth-Token": API_TOKEN } }
  );

  if (!response.ok) {
    throw new Error(`API football : HTTP ${response.status} (${path})`);
  }

  return response.json();
}

// File d'attente : les appels API passent un par un.
let apiQueue = Promise.resolve();

function api(path) {
  const run = apiQueue.then(() => apiRequest(path));
  apiQueue = run.catch(() => {});
  return run;
}

async function sendAll(message) {
  for (const chatId of [...state.chats]) {
    try {
      await bot.telegram.sendMessage(chatId, message);
    } catch (e) {
      console.error("Erreur Telegram :", e.message);

      if (e.response?.error_code === 403 || e.response?.error_code === 400) {
        state.chats = state.chats.filter(id => id !== chatId);
        save();
      }
    }
  }
}

async function getMatches() {
  const yesterday = localDate(new Date(Date.now() - 86400000));
  const tomorrow = localDate(new Date(Date.now() + 86400000));

  const data = await api(
    `/matches?dateFrom=${yesterday}&dateTo=${tomorrow}`
  );

  return data.matches || [];
}

const historyCache = new Map();

async function teamStats(teamId) {
  const cached = historyCache.get(teamId);

  if (cached && Date.now() - cached.time < 6 * 60 * 60 * 1000) {
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
  const results = [];

  for (const m of matches) {
    const isHome = m.homeTeam.id === teamId;
    const homeGoals = m.score.fullTime.home;
    const awayGoals = m.score.fullTime.away;

    const gf = isHome ? homeGoals : awayGoals;
    const ga = isHome ? awayGoals : homeGoals;

    scored += gf;
    conceded += ga;
    results.push(gf > ga ? "W" : gf === ga ? "D" : "L");
  }

  const stats = {
    played: matches.length,
    scored: scored / matches.length,
    conceded: conceded / matches.length,
    // 5 derniers matchs, du plus ancien au plus récent
    form: results.slice(0, 5).reverse()
  };

  historyCache.set(teamId, { time: Date.now(), stats });
  return stats;
}

function poisson(k, lambda) {
  let factorial = 1;
  for (let i = 2; i <= k; i++) factorial *= i;
  return Math.exp(-lambda) * Math.pow(lambda, k) / factorial;
}

// Plus petit nombre de buts k tel que P(buts ≤ k) ≥ q
function highGoals(lambda, q = 0.75) {
  let cumulative = 0;
  for (let k = 0; k <= 10; k++) {
    cumulative += poisson(k, lambda);
    if (cumulative >= q) return k;
  }
  return 10;
}

function predict(homeLambda, awayLambda) {
  const scores = [];
  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  let over2 = 0;
  let over3 = 0;
  let over4 = 0;
  let btts = 0;

  for (let h = 0; h <= 7; h++) {
    for (let a = 0; a <= 7; a++) {
      const p = poisson(h, homeLambda) * poisson(a, awayLambda);
      scores.push({ h, a, p });

      if (h > a) homeWin += p;
      else if (h === a) draw += p;
      else awayWin += p;

      if (h + a >= 2) over2 += p;
      if (h + a >= 3) over3 += p;
      if (h + a >= 4) over4 += p;
      if (h > 0 && a > 0) btts += p;
    }
  }

  scores.sort((a, b) => b.p - a.p);
  const total = homeWin + draw + awayWin;

  const best = scores.find(s => s.h + s.a >= MIN_GOALS) || scores[0];

  return {
    best,
    top: scores[0],
    top3: scores.slice(0, 3),
    homeWin: homeWin / total,
    draw: draw / total,
    awayWin: awayWin / total,
    over2: over2 / total,
    over3: over3 / total,
    over4: over4 / total,
    btts: btts / total
  };
}

function pct(value) {
  return (value * 100).toFixed(1) + "%";
}

function predictedOutcome(p) {
  const max = Math.max(p.homeWin, p.draw, p.awayWin);
  if (max === p.homeWin) return "H";
  if (max === p.draw) return "D";
  return "A";
}

function outcomeLabel(outcome, homeName, awayName) {
  if (outcome === "H") return `victoire de ${homeName}`;
  if (outcome === "A") return `victoire de ${awayName}`;
  return "match nul";
}

function confidence(p, home, away) {
  const maxP = Math.max(p.homeWin, p.draw, p.awayWin);
  const sample = Math.min(home.played, away.played);

  if (sample < 6) return "🟠 Faible (peu de données)";
  if (maxP >= 0.55) return "🟢 Élevée";
  if (maxP >= 0.42) return "🟡 Moyenne";
  return "🟠 Faible (match très ouvert)";
}

function formString(form) {
  const emoji = { W: "🟢", D: "🟡", L: "🔴" };
  return form.map(r => emoji[r]).join("");
}

// 🎁 Bloc surprise : spectacle, premier but, piège, 0-0
function surpriseBlock(homeName, awayName, homeLambda, awayLambda, p) {
  const totalLambda = homeLambda + awayLambda;
  const p00 = poisson(0, homeLambda) * poisson(0, awayLambda);

  const spectacle = Math.round(
    Math.min(
      100,
      Math.max(
        0,
        (totalLambda / 4) * 55 +
          p.btts * 30 +
          (1 - Math.abs(p.homeWin - p.awayWin)) * 15
      )
    )
  );

  const filled = Math.round(spectacle / 10);
  const bar = "🔥".repeat(filled) + "▫️".repeat(10 - filled);

  let label;
  if (spectacle >= 75) label = "Match explosif 💥";
  else if (spectacle >= 55) label = "Match animé";
  else if (spectacle >= 35) label = "Match équilibré";
  else label = "Match fermé 🔒";

  let firstGoal;
  if (p00 > 0.5) {
    firstGoal = "match très fermé, un 0-0 est plausible";
  } else {
    const minute = Math.max(1, Math.round((90 * Math.LN2) / totalLambda));
    firstGoal = `vers la minute ${minute}`;
  }

  const homeFav = p.homeWin >= p.awayWin;
  const favName = homeFav ? homeName : awayName;
  const dogName = homeFav ? awayName : homeName;
  const favP = homeFav ? p.homeWin : p.awayWin;
  const dogP = homeFav ? p.awayWin : p.homeWin;

  let upset;
  if (favP >= 0.5 && dogP >= 0.2) {
    upset = `⚠️ Piège possible : ${dogName} peut créer la surprise (${pct(dogP)})`;
  } else if (favP >= 0.5) {
    upset = `✅ Favori solide : ${favName} (${pct(favP)})`;
  } else {
    upset = "🎲 Match très ouvert, aucun favori net";
  }

  return (
    `🎁 SURPRISE JARVIS\n` +
    `• Spectacle : ${bar} ${spectacle}/100 — ${label}\n` +
    `• Premier but attendu : ${firstGoal}\n` +
    `• ${upset}\n` +
    `• Risque de 0-0 : ${pct(p00)}\n\n`
  );
}

// Retourne { text, pred } : le message et la prédiction à vérifier plus tard
async function analyzeMatch(match) {
  const homeName = match.homeTeam.name;
  const awayName = match.awayTeam.name;

  const home = await teamStats(match.homeTeam.id);
  const away = await teamStats(match.awayTeam.id);

  if (!home || !away) {
    return {
      text:
        `⚽ ${homeName} - ${awayName}\n\n` +
        "Données insuffisantes pour calculer une estimation.",
      pred: null
    };
  }

  const homeLambda = Math.max(0.15, (home.scored + away.conceded) / 2);
  const awayLambda = Math.max(0.15, (away.scored + home.conceded) / 2);

  const p = predict(homeLambda, awayLambda);

  const highHome = highGoals(homeLambda);
  const highAway = highGoals(awayLambda);
  const highProb =
    poisson(highHome, homeLambda) * poisson(highAway, awayLambda);

  const top3 = p.top3
    .map((s, i) => `${i + 1}. ${s.h} - ${s.a} (${pct(s.p)})`)
    .join("\n");

  const text =
    `📊 ESTIMATION STATISTIQUE\n\n` +
    `⚽ ${homeName} - ${awayName}\n` +
    `📅 ${localDate(new Date(match.utcDate))} à ` +
    `${localTime(new Date(match.utcDate))} (Togo)\n\n` +
    `Buts attendus selon le modèle :\n` +
    `• ${homeName} : ${homeLambda.toFixed(2)}\n` +
    `• ${awayName} : ${awayLambda.toFixed(2)}\n\n` +
    `🎯 Score prédit (au moins ${MIN_GOALS} buts) :\n` +
    `• ${homeName} ${p.best.h} - ${p.best.a} ${awayName} ` +
    `(probabilité : ${pct(p.best.p)})\n\n` +
    `🔢 Top 3 des scores exacts :\n${top3}\n\n` +
    `Prédiction haute (fourchette haute) :\n` +
    `• ${homeName} ${highHome} - ${highAway} ${awayName} ` +
    `(probabilité exacte : ${pct(highProb)})\n\n` +
    `Probabilités estimées :\n` +
    `• Victoire domicile : ${pct(p.homeWin)}\n` +
    `• Match nul : ${pct(p.draw)}\n` +
    `• Victoire extérieur : ${pct(p.awayWin)}\n` +
    `🧠 Confiance du modèle : ${confidence(p, home, away)}\n\n` +
    `📈 Nombre de buts :\n` +
    `• 2 buts ou plus : ${pct(p.over2)}\n` +
    `• 3 buts ou plus : ${pct(p.over3)}\n` +
    `• 4 buts ou plus : ${pct(p.over4)}\n` +
    `• Les deux équipes marquent : ${pct(p.btts)}\n\n` +
    `📋 Forme sur 5 matchs (ancien → récent) :\n` +
    `• ${homeName} : ${formString(home.form)}\n` +
    `• ${awayName} : ${formString(away.form)}\n\n` +
    surpriseBlock(homeName, awayName, homeLambda, awayLambda, p) +
    `Échantillon : les ${home.played} derniers matchs de ` +
    `${homeName} et les ${away.played} derniers de ${awayName}.\n\n` +
    `⚠️ Estimation indicative, sans garantie. Le modèle ne tient ` +
    `pas compte des blessures, des compositions ni de la force des adversaires.`;

  const pred = {
    home: homeName,
    away: awayName,
    h: p.best.h,
    a: p.best.a,
    outcome: predictedOutcome(p),
    minGoals: MIN_GOALS
  };

  return { text, pred };
}

function matchLine(m) {
  const names = `${m.homeTeam.name} - ${m.awayTeam.name}`;
  const s = m.score?.fullTime;

  if (m.status === "FINISHED" && s?.home != null && s?.away != null) {
    return `🏁 ${m.homeTeam.name} ${s.home} - ${s.away} ${m.awayTeam.name}`;
  }
  if (["IN_PLAY", "PAUSED"].includes(m.status)) {
    return `🔴 EN DIRECT : ${names}`;
  }
  if (["POSTPONED", "CANCELLED", "SUSPENDED"].includes(m.status)) {
    return `⛔ ${names} (reporté ou annulé)`;
  }
  return `🕒 ${localTime(new Date(m.utcDate))} — ${names}`;
}

function bilanText(title, s) {
  const rate = n => ((n / s.total) * 100).toFixed(0) + "%";

  return (
    `📊 ${title} (${s.total} match${s.total > 1 ? "s" : ""} vérifié${s.total > 1 ? "s" : ""})\n\n` +
    `• Bonne issue (victoire/nul/défaite) : ${s.outcomeOk}/${s.total} (${rate(s.outcomeOk)})\n` +
    `• Score exact : ${s.exactOk}/${s.total} (${rate(s.exactOk)})\n` +
    `• ${MIN_GOALS} buts ou plus : ${s.minGoalsOk}/${s.total} (${rate(s.minGoalsOk)})\n\n` +
    `⚠️ Bilan indicatif : un petit nombre de matchs ne prouve rien.`
  );
}

// Enregistre automatiquement tout chat privé qui écrit au bot (plus besoin de /start)
bot.use((ctx, next) => {
  if (
    ctx.chat &&
    ctx.chat.type === "private" &&
    !state.chats.includes(ctx.chat.id)
  ) {
    state.chats.push(ctx.chat.id);
    save();
  }
  return next();
});

bot.start(ctx =>
  ctx.reply(
    "JARVIS Football est actif !\n\n" +
    "Tu n'as plus rien à faire : tu recevras automatiquement\n" +
    "• les matchs du jour à 6 h\n" +
    "• l'estimation 30 min avant chaque match\n" +
    "• le score final et la vérification de la prédiction\n" +
    `• le bilan du jour à ${BILAN_FROM}\n\n` +
    "Commandes (facultatives) : /matchs, /bilan, /ping, /help"
  )
);

bot.command("ping", ctx => ctx.reply("JARVIS est en ligne !"));

bot.command("matchs", async ctx => {
  try {
    await ctx.reply("🔎 Je cherche les matchs du jour...");

    const matches = await getMatches();
    const today = localDate();

    const list = matches
      .filter(m => localDate(new Date(m.utcDate)) === today)
      .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate))
      .slice(0, 20);

    if (list.length === 0) {
      return ctx.reply("Aucun match trouvé aujourd'hui dans les compétitions accessibles.");
    }

    await ctx.reply(
      `⚽ MATCHS DU JOUR (${today})\n\n` + list.map(matchLine).join("\n")
    );
  } catch (e) {
    console.error("Commande /matchs :", e.message);
    await ctx.reply("Impossible de récupérer les matchs pour le moment.");
  }
});

bot.command("bilan", ctx => {
  if (!state.stats.total) {
    return ctx.reply(
      "📊 Pas encore de bilan : JARVIS doit d'abord vérifier quelques matchs."
    );
  }
  return ctx.reply(bilanText("BILAN GÉNÉRAL JARVIS", state.stats));
});

bot.help(ctx => ctx.reply(
  "JARVIS fonctionne tout seul : matchs à 6 h, estimations avant les " +
  `rencontres, scores finaux, et bilan du jour à ${BILAN_FROM}.\n\n` +
  "/matchs — matchs du jour (facultatif)\n" +
  "/bilan — bilan général (facultatif)"
));

bot.catch(err => {
  console.error("Erreur bot :", err.message);
});

let busy = false;

async function runChecks() {
  if (busy) return;
  busy = true;

  try {
    const now = Date.now();
    const today = localDate();
    const time = localTime();

    // 📊 Bilan automatique du jour (ne dépend pas de l'API football)
    if (
      time >= BILAN_FROM &&
      time <= BILAN_TO &&
      state.bilanSent !== today
    ) {
      if (state.daily.date === today && state.daily.total > 0) {
        await sendAll(bilanText("BILAN DU JOUR JARVIS", state.daily));
      }
      state.bilanSent = today;
      save();
    }

    const matches = await getMatches();

    // Envoi entre 06:00 et 06:10, heure du Togo.
    if (time >= "06:00" && time <= "06:10" && state.dailySent !== today) {
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
      try {
        const id = String(match.id);
        const start = new Date(match.utcDate).getTime();
        const minutes = (start - now) / 60000;

        // Estimation dans les 30 minutes avant le match.
        if (
          ["SCHEDULED", "TIMED"].includes(match.status) &&
          minutes > 0 &&
          minutes <= 30 &&
          !state.reminders.includes(id)
        ) {
          const { text, pred } = await analyzeMatch(match);

          await sendAll(`⏰ MATCH DANS ENVIRON 30 MINUTES\n\n${text}`);

          state.reminders.push(id);
          if (pred) state.predictions[id] = pred;
          save();
        }

        // Score final + vérification de la prédiction.
        if (
          match.status === "FINISHED" &&
          state.reminders.includes(id) &&
          !state.resultsSent.includes(id)
        ) {
          const score = match.score?.fullTime;

          if (score && score.home != null && score.away != null) {
            let message =
              `🏁 SCORE FINAL\n\n${match.homeTeam.name} ` +
              `${score.home} - ${score.away} ${match.awayTeam.name}`;

            const pred = state.predictions[id];

            if (pred) {
              const actual =
                score.home > score.away ? "H" :
                score.home < score.away ? "A" : "D";

              const okOutcome = pred.outcome === actual;
              const okExact = pred.h === score.home && pred.a === score.away;
              const okGoals = score.home + score.away >= pred.minGoals;

              // Bilan général
              state.stats.total++;
              if (okOutcome) state.stats.outcomeOk++;
              if (okExact) state.stats.exactOk++;
              if (okGoals) state.stats.minGoalsOk++;

              // Bilan du jour
              if (state.daily.date !== today) {
                state.daily = { ...emptyDaily(), date: today };
              }
              state.daily.total++;
              if (okOutcome) state.daily.outcomeOk++;
              if (okExact) state.daily.exactOk++;
              if (okGoals) state.daily.minGoalsOk++;

              message +=
                `\n\n🔎 VÉRIFICATION JARVIS\n` +
                `• Score prédit : ${pred.h} - ${pred.a} ` +
                `${okExact ? "✅ exact !" : "❌"}\n` +
                `• Issue prévue : ` +
                `${outcomeLabel(pred.outcome, pred.home, pred.away)} ` +
                `${okOutcome ? "✅" : "❌"}\n` +
                `• ${pred.minGoals} buts ou plus : ${okGoals ? "✅" : "❌"}`;

              delete state.predictions[id];
            }

            await sendAll(message);

            state.resultsSent.push(id);
            save();
          }
        }
      } catch (e) {
        console.error(`Match ${match.id} :`, e.message);
      }
    }
  } catch (e) {
    console.error("Vérification :", e.message);
  } finally {
    busy = false;
  }
}

bot.launch(() => console.log("JARVIS démarré."))
  .catch(e => console.error("Erreur Telegram :", e.message));

setInterval(runChecks, 60000);
runChecks();

process.on("unhandledRejection", e => console.error("Promesse rejetée :", e));
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
