// Orion — backend feed aggregator
// Scarica gli RSS delle testate, li categorizza (macro/azioni/crypto/forex/obbligazioni/materie)
// e li serve come JSON al frontend statico. Pensato per girare su Render, stesso pattern di ob-proxy.

const express = require('express');
const cors = require('cors');
const Parser = require('rss-parser');
const cheerio = require('cheerio');
const webpush = require('web-push');

const app = express();
const parser = new Parser({ timeout: 10000 });

app.use(cors()); // in produzione puoi restringere all'origine del tuo sito statico
app.use(express.json());

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// ---------------------------------------------------------------------------
// Chiamata condivisa a Groq, usata da tutte le funzioni IA di questo file.
// Se Groq risponde 429 (troppe richieste — capita anche perché il limite è
// per ACCOUNT, non per chiave: se la stessa chiave la usa anche Clark nello
// stesso momento, i conteggi si sommano), aspettiamo il tempo indicato da
// Groq stesso (header Retry-After) e riproviamo una volta sola prima di
// arrenderci, invece di fallire subito al primo intoppo.
// ---------------------------------------------------------------------------
async function callGroq(prompt, maxTokens, temperature = 0.3) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature,
        max_tokens: maxTokens,
      }),
    });

    if (res.status === 429 && attempt === 1) {
      const waitSeconds = Number(res.headers.get('retry-after')) || 8;
      console.warn(`[orion] Groq 429 (troppe richieste), riprovo tra ${waitSeconds}s...`);
      await sleep(waitSeconds * 1000);
      continue;
    }
    if (!res.ok) throw new Error(`Groq status ${res.status}`);

    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || '';
  }
  throw new Error('Groq status 429 (persistente dopo un tentativo di attesa)');
}

// ---------------------------------------------------------------------------
// 0. NOTIFICHE PUSH — servono le chiavi VAPID come variabili d'ambiente su
// Render (Settings → Environment): VAPID_PUBLIC_KEY e VAPID_PRIVATE_KEY.
// Senza queste due, le notifiche restano semplicemente disattivate — il resto
// dell'app funziona lo stesso.
// ---------------------------------------------------------------------------
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const pushEnabled = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

if (pushEnabled) {
  webpush.setVapidDetails('mailto:orion-app@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn('[orion] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY non impostate: notifiche push disattivate.');
}

// Iscrizioni salvate in memoria (un dispositivo = un abbonamento). Come per la
// cache dei feed, si svuotano se Render riavvia il servizio — per qualcosa di
// permanente andrebbe salvato su un database, ma per iniziare va bene così.
let pushSubscriptions = [];
let notifiedLinks = new Set(); // per non notificare due volte lo stesso articolo
let hasRunNotifyCheck = false; // false finché non abbiamo fatto il primo giro "silenzioso" dopo l'avvio
let dailyNotifyCount = 0;
let dailyNotifyResetDate = new Date().toDateString();
const MAX_NOTIFICATIONS_PER_DAY = 5;

// Parole chiave per capire se una notizia è "importante" o un evento speciale
// (eventi da banca centrale, mosse improvvise dei mercati). Semplice ma gratis
// e veloce — nessuna chiamata IA aggiuntiva per questo controllo.
const IMPORTANCE_KEYWORDS = [
  'crolla', 'crollo', 'crolli', 'precipita', 'affonda', 'record', 'shock',
  'storico', 'storica', 'taglia i tassi', 'alza i tassi', 'rialzo dei tassi',
  'taglio dei tassi', 'allarme', 'panico', 'balzo', 'impenna', 'sospende le contrattazioni',
  'fallimento', 'bancarotta', 'crash', 'plunge', 'plunges', 'surges', 'surge',
  'record high', 'all-time high', 'emergency', 'slashes rates', 'hikes rates',
  'halts trading', 'bankruptcy', 'default',
];

function isImportant(title) {
  const t = title.toLowerCase();
  return IMPORTANCE_KEYWORDS.some((k) => t.includes(k));
}

// ---------------------------------------------------------------------------
// 1. FONTI — aggiungi/rimuovi feed qui. Tutti RSS pubblici, nessuna chiave richiesta.
//
// Ogni fonte ha già la sua categoria "di nascita" (forceCategory): niente più
// indovinelli via parole chiave per queste, quindi niente più "tutto in macro".
// Le parole chiave restano solo come ripiego per le 2-3 fonti davvero generaliste
// in fondo alla lista (Reuters, CNBC, Yahoo Finance), che non sono divise per argomento.
// ---------------------------------------------------------------------------
const FEEDS = [
  // --- CRYPTO: confermate funzionanti ---
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', source: 'CoinDesk', forceCategory: 'crypto' },
  { url: 'https://cointelegraph.com/rss', source: 'CoinTelegraph', forceCategory: 'crypto' },

  // --- FOREX: FXStreet e DailyFX bloccano le richieste automatiche (403),
  // proviamo ForexLive (blog, di solito il classico feed WordPress funziona) ---
  { url: 'https://www.forexlive.com/feed', source: 'ForexLive', forceCategory: 'forex' },

  // --- MATERIE PRIME: confermata funzionante ---
  { url: 'https://oilprice.com/rss/main', source: 'OilPrice.com', forceCategory: 'materie' },

  // --- AZIONI: confermata funzionante ---
  { url: 'https://www.marketwatch.com/rss/topstories', source: 'MarketWatch', forceCategory: 'azioni' },

  // --- OBBLIGAZIONI: per ora nessuna fonte dedicata affidabile trovata — resta
  // vuota finché non ne troviamo una che funzioni davvero (vedi messaggio) ---

  // --- MACRO: confermate funzionanti ---
  { url: 'https://www.investing.com/rss/news_301.rss', source: 'Investing.com', forceCategory: 'macro' },
  { url: 'https://www.ansa.it/sito/notizie/economia/economia_rss.xml', source: 'ANSA Economia', forceCategory: 'macro' },
  { url: 'https://www.ilsole24ore.com/rss/finanza.xml', source: 'Il Sole 24 Ore', forceCategory: 'macro' },

  // --- fonti generaliste: qui NON conosciamo l'argomento in anticipo, quindi
  // resta il matching per parole chiave (bilingue) come ripiego. Sono anche le
  // uniche a poter alimentare "obbligazioni" per ora, quando capita un titolo
  // che parla di BTP/bond/yield ---
  { url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', source: 'CNBC Markets' },
  { url: 'https://finance.yahoo.com/news/rssindex', source: 'Yahoo Finance' },
];
// Reuters rimosso: feeds.reuters.com non esiste più (dominio non risolve).
// FXStreet, DailyFX, Milano Finanza (sezioni borsa/obbligazioni) e quasi tutti
// gli URL "per categoria" di Investing.com rimossi: davano 404/403 nel test reale.

// ---------------------------------------------------------------------------
// 2. CATEGORIZZAZIONE — usata solo per le fonti generaliste (senza forceCategory).
// Parole chiave sia in italiano che in inglese: molte testate (Reuters, CNBC,
// MarketWatch...) scrivono i titoli in inglese, e prima riconoscevamo solo
// l'italiano — per questo quasi tutto finiva nel "macro" di default.
// ---------------------------------------------------------------------------
const CATEGORY_KEYWORDS = {
  crypto: ['bitcoin', 'btc', 'ethereum', 'eth', 'crypto', 'blockchain', 'token', 'defi', 'stablecoin', 'altcoin', 'solana', 'binance'],
  forex: ['dollaro', 'euro', 'yen', 'sterlina', 'cambio', 'forex', 'usd/', 'eur/', 'valuta', 'currency', 'exchange rate', 'dollar', 'yuan', 'pound', 'fx '],
  obbligazioni: ['btp', 'bond', 'obbligazion', 'spread', 'rendimento', 'treasury', 'bund', 'yield', 'gilt', 'note auction'],
  materie: ['petrolio', 'brent', 'oro', 'gas naturale', 'materie prime', 'oil', 'gold', 'commodity', 'commodities', 'opec', 'wti', 'natural gas', 'copper', 'silver'],
  azioni: ['borsa', 'piazza affari', 'ftse', 'nasdaq', 'wall street', 'azioni', 'trimestrale', 'utili', 'ipo', 'stock', 'stocks', 'shares', 'earnings', 's&p', 'dow jones', 'equities', 'nyse'],
  macro: ['bce', 'fed', 'inflazione', 'pil', 'tassi', 'disoccupazione', 'occupazione', 'banca centrale', 'inflation', 'gdp', 'interest rate', 'unemployment', 'central bank', 'ecb', 'recession', 'jobs report'],
};

function categorize(title) {
  const t = title.toLowerCase();
  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((k) => t.includes(k))) return cat;
  }
  return 'macro'; // fallback di default, quando davvero non riconosce nulla
}

const CATEGORY_LABELS = {
  macro: 'Macro', azioni: 'Azioni', crypto: 'Crypto',
  forex: 'Forex', obbligazioni: 'Obbligazioni', materie: 'Materie prime',
};

// ---------------------------------------------------------------------------
// 2b. RIASSUNTO IA PER CATEGORIA — usa Groq (stesso provider di Clark) per
// scrivere un piccolo paragrafo che riassume le notizie del giorno per ogni
// categoria. Serve la variabile d'ambiente GROQ_API_KEY su Render (Settings →
// Environment). Se manca, l'app funziona lo stesso: i riassunti restano vuoti.
// ---------------------------------------------------------------------------
const GROQ_MODEL = 'llama-3.1-8b-instant'; // veloce ed economico, va benissimo per un riassunto breve

// Controllo di sicurezza sul testo che torna da Groq: se sembra rotto,
// vuoto, tagliato a metà o sospetto, meglio non mostrare nulla (o un testo
// accorciato ma completo) che mostrare un riassunto rovinato o interrotto
// a metà frase.
function sanitizeSummary(text, label) {
  if (!text) return null;

  // ripulisce eventuale markdown residuo (anche se il prompt lo vieta esplicitamente)
  let clean = text.replace(/[*_#`]/g, '').trim();

  // troppo corto per essere un vero riassunto (es. Groq ha risposto con un errore o "Mi dispiace...")
  if (clean.length < 25) {
    console.warn(`[orion] riassunto scartato per ${label}: troppo corto ("${clean}")`);
    return null;
  }

  // frasi tipiche di un modello che si scusa/rifiuta invece di riassumere
  const redFlags = ['mi dispiace', 'non posso', 'as an ai', 'i cannot', "i'm sorry"];
  if (redFlags.some((f) => clean.toLowerCase().startsWith(f))) {
    console.warn(`[orion] riassunto scartato per ${label}: sembra un rifiuto/scusa del modello`);
    return null;
  }

  // troppo lungo: qualcosa è andato storto col limite di token, tagliamo per sicurezza
  // (il taglio vero e proprio, a fine frase, avviene comunque nel controllo qui sotto)
  if (clean.length > 2500) clean = clean.slice(0, 2500);

  // testo tagliato a metà: se non finisce con un punto/esclamativo/domanda,
  // Groq è stato interrotto a metà frase (di solito per il limite di token).
  // Meglio accorciare all'ultima frase completa che mostrare un troncamento.
  const endsProperly = /[.!?…]["')]?$/.test(clean);
  if (!endsProperly) {
    const lastSentenceEnd = Math.max(clean.lastIndexOf('.'), clean.lastIndexOf('!'), clean.lastIndexOf('?'));
    if (lastSentenceEnd + 1 >= 25) {
      // c'è almeno una frase completa abbastanza sostanziosa: teniamo quella
      console.warn(`[orion] riassunto per ${label} tagliato a metà, accorciato all'ultima frase completa`);
      clean = clean.slice(0, lastSentenceEnd + 1).trim();
    } else {
      // troppo poco testo completo per essere utile: meglio scartare tutto
      console.warn(`[orion] riassunto scartato per ${label}: tagliato a metà senza una frase completa recuperabile`);
      return null;
    }
  }

  return clean;
}

let categorySummaryStatus = {}; // diagnostica: perché una categoria è riuscita o no

async function summarizeCategory(categoryKey, articles) {
  if (!articles.length) {
    categorySummaryStatus[categoryKey] = 'nessuna notizia disponibile per questa categoria';
    return null;
  }

  const bullets = articles
    .slice(0, 10)
    .map((a) => `- ${a.title}${a.summary ? ': ' + a.summary : ''}`)
    .join('\n');

  const prompt = `Sei l'assistente editoriale di un'app di notizie finanziarie chiamata Orion.
Qui sotto trovi i titoli (e riassunti) delle notizie di oggi nella categoria "${CATEGORY_LABELS[categoryKey]}".
Scrivi un riassunto dettagliato e concreto della giornata in questa categoria, in italiano, di circa
8-12 frasi (anche in 2-3 brevi paragrafi se aiuta la lettura). Copri più temi distinti se ci sono
(non fermarti alla prima notizia), riporta numeri/dati/nomi citati nei testi, e dai un minimo di
contesto su perché ogni cosa è rilevante. Tono neutro e informativo, come un notiziario approfondito.
Non inventare numeri o fatti che non sono nel testo qui sotto. Non usare markdown.

Notizie:
${bullets}`;

  try {
    const raw = await callGroq(prompt, 700);
    const result = sanitizeSummary(raw, categoryKey);

    if (result) {
      categorySummaryStatus[categoryKey] = `ok (${result.length} caratteri)`;
    } else {
      categorySummaryStatus[categoryKey] =
        `scartato — Groq ha risposto ${raw.length} caratteri, ma non ha superato i controlli di qualità. ` +
        `Testo grezzo: "${raw.slice(0, 150)}${raw.length > 150 ? '...' : ''}"`;
    }
    return result;
  } catch (err) {
    categorySummaryStatus[categoryKey] = `errore: ${err.message}`;
    console.error(`[orion] errore riassunto IA per ${categoryKey}:`, err.message);
    return null;
  }
}

let categorySummaries = {};

// ---------------------------------------------------------------------------
// 2c. RIASSUNTO IA PER IL SINGOLO ARTICOLO — a differenza di quello per
// categoria, questo viene generato al momento (quando l'utente apre il
// pannello dell'articolo in Orion), non per tutti gli articoli ad ogni
// aggiornamento — altrimenti sarebbero centinaia di chiamate a Groq ogni
// 20 minuti per articoli che magari nessuno apre mai.
//
// IMPORTANTE: il feed RSS fornisce solo titolo + un breve estratto, mai il
// testo completo dell'articolo. Questo riassunto quindi rende più chiaro e
// scorrevole quello che già sappiamo (titolo+estratto) — non "legge" parti
// dell'articolo che non sono nell'anteprima RSS.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 2c. RIASSUNTO IA PER IL SINGOLO ARTICOLO — generato al momento (quando
// l'utente apre il pannello in Orion), non per tutti gli articoli ad ogni
// aggiornamento — altrimenti sarebbero centinaia di chiamate a Groq ogni
// 20 minuti per articoli che magari nessuno apre mai.
//
// Prima prova a scaricare ed estrarre il testo vero dell'articolo dal sito
// della testata, per fare un riassunto più corposo e con più contenuto reale.
// Se il sito blocca lo scraping, ha paywall, o l'estrazione fallisce, torna
// comunque un riassunto breve basato solo su titolo+estratto RSS — non lascia
// mai l'utente senza nulla.
// ---------------------------------------------------------------------------
async function fetchArticleText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OrionNewsBot/1.0)' },
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const html = await res.text();
    const $ = cheerio.load(html);
    $('script, style, nav, header, footer, aside, form, iframe, noscript').remove();

    // proviamo prima dentro <article>, se c'è (la maggior parte dei siti di news la usa)
    let container = $('article');
    if (!container.length) container = $('body');

    const paragraphs = container
      .find('p')
      .map((_, el) => $(el).text().trim())
      .get()
      .filter((t) => t.length > 40); // scarta didascalie/frammenti troppo corti

    const text = paragraphs.join('\n').slice(0, 6000); // limite ragionevole per il prompt
    return text.length > 200 ? text : null; // troppo poco estratto: non serve a niente
  } catch (err) {
    console.warn(`[orion] impossibile estrarre il testo di ${url}:`, err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function summarizeArticle(title, snippet, link) {
  const fullText = link ? await fetchArticleText(link) : null;

  const prompt = fullText
    ? `Sei l'assistente editoriale dell'app di notizie finanziarie Orion.
Qui sotto trovi il testo estratto di un articolo vero. Scrivi in italiano un riassunto
completo e concreto (5-8 frasi, anche in 2 brevi paragrafi se utile), che riporti i
punti chiave, i numeri/dati citati e il contesto principale. Resta fedele al testo:
non inventare fatti, numeri o dichiarazioni che non ci sono. Non citare frasi intere
tra virgolette, riformula sempre con parole tue. Non usare markdown.

Titolo: ${title}

Testo dell'articolo:
${fullText}`
    : `Sei l'assistente editoriale dell'app di notizie finanziarie Orion.
Hai solo il titolo e un breve estratto di un articolo (non il testo completo, non sono
riuscito a scaricarlo dal sito). Riscrivi in italiano, in 2-3 frasi chiare, quello che si
capisce dal titolo e dall'estratto — senza inventare dettagli che non ci sono. Tono
neutro e informativo. Non usare markdown.

Titolo: ${title}
Estratto: ${snippet || '(nessun estratto disponibile, basati solo sul titolo)'}`;

  const raw = await callGroq(prompt, fullText ? 500 : 160);
  return { text: sanitizeSummary(raw, `articolo "${title.slice(0, 40)}..."`), fromFullText: !!fullText };
}

app.post('/api/article-summary', async (req, res) => {
  if (!process.env.GROQ_API_KEY) {
    return res.status(503).json({ error: 'GROQ_API_KEY non configurata sul server' });
  }
  const { title, summary, link } = req.body || {};
  if (!title) {
    return res.status(400).json({ error: 'manca il titolo dell\'articolo' });
  }
  try {
    const { text, fromFullText } = await summarizeArticle(title, summary || '', link);
    res.json({ summary: text, fromFullText }); // "summary: null" se Groq ha risposto male: il frontend userà l'estratto grezzo
  } catch (err) {
    console.error('[orion] errore riassunto articolo:', err.message);
    res.status(502).json({ error: 'riassunto non disponibile', summary: null });
  }
});

async function generateSummaries() {
  if (!process.env.GROQ_API_KEY) {
    console.warn('[orion] GROQ_API_KEY non impostata: salto i riassunti IA.');
    return;
  }
  const newSummaries = {};
  for (const cat of Object.keys(CATEGORY_LABELS)) {
    const articles = feedCache.filter((a) => a.category === cat);
    newSummaries[cat] = await summarizeCategory(cat, articles);
    await sleep(3000); // piccola pausa tra una categoria e l'altra, per non "raffica-re" Groq
  }
  categorySummaries = newSummaries;
  console.log('[orion] riassunti IA aggiornati per', Object.keys(newSummaries).filter(k => newSummaries[k]).length, 'categorie');

  archiveTodaysSummaries();
}

// ---------------------------------------------------------------------------
// 2e. RIEPILOGO SETTIMANALE — mette da parte il riassunto di ogni giorno (una
// volta al giorno, non ad ogni ciclo) e poi chiede a Groq di ricucire gli
// ultimi giorni in una retrospettiva. L'archivio vive in memoria: se il
// servizio su Render si riavvia, si riparte da zero. Per questo il riepilogo
// dice sempre onestamente quanti giorni copre davvero, invece di finger di
// avere sempre 7 giorni pieni.
// ---------------------------------------------------------------------------
let dailyArchive = {}; // { categoria: [ {date:'2026-07-29', text:'...'}, ... ] }
let weeklySummaries = {};
let weeklySummariesGeneratedOn = null;

function archiveTodaysSummaries() {
  const today = new Date().toISOString().slice(0, 10); // es. "2026-07-29"
  for (const cat of Object.keys(CATEGORY_LABELS)) {
    const text = categorySummaries[cat];
    if (!text) continue;
    if (!dailyArchive[cat]) dailyArchive[cat] = [];
    const alreadyLoggedToday = dailyArchive[cat].some((d) => d.date === today);
    if (alreadyLoggedToday) {
      // aggiorna con la versione più recente di oggi, non duplica la voce
      dailyArchive[cat] = dailyArchive[cat].map((d) => (d.date === today ? { date: today, text } : d));
    } else {
      dailyArchive[cat].push({ date: today, text });
    }
    dailyArchive[cat] = dailyArchive[cat].slice(-7); // solo gli ultimi 7 giorni
  }
}

async function summarizeWeek(categoryKey, days) {
  if (days.length < 2) return null; // con un solo giorno non è ancora una "retrospettiva"

  const daysList = days.map((d) => `[${d.date}]\n${d.text}`).join('\n\n');
  const prompt = `Sei l'assistente editoriale dell'app di notizie finanziarie Orion.
Qui sotto trovi i riassunti giornalieri delle notizie di categoria "${CATEGORY_LABELS[categoryKey]}"
degli ultimi ${days.length} giorni disponibili. Scrivi una retrospettiva in italiano (6-10 frasi)
che ricuci l'evoluzione dei temi principali nel periodo: cosa è cambiato, cosa si è confermato,
quali temi sono ricorrenti. Non limitarti a elencare i giorni uno per uno, sintetizza il filo
conduttore. Non inventare fatti che non sono nel testo. Non usare markdown.

${daysList}`;

  try {
    const raw = await callGroq(prompt, 500);
    return sanitizeSummary(raw, `settimana ${categoryKey}`);
  } catch (err) {
    console.warn(`[orion] riepilogo settimanale fallito per ${categoryKey}:`, err.message);
    return null;
  }
}

async function classifyTextSentiment(text) {
  if (!text) return null;
  const prompt = `Classifica il tono generale di questo testo finanziario come "rialzista",
"ribassista" o "neutro". Rispondi SOLO con una di queste tre parole, senza nient'altro.

Testo:
${text}`;
  try {
    const raw = await callGroq(prompt, 10, 0.1);
    const cleaned = raw.trim().toLowerCase().replace(/[^a-zà-ù]/g, '');
    return VALID_SENTIMENTS.includes(cleaned) ? cleaned : null;
  } catch (err) {
    console.warn('[orion] classificazione sentiment settimanale fallita:', err.message);
    return null;
  }
}

async function generateWeeklySummaries() {
  if (!process.env.GROQ_API_KEY) return;
  const today = new Date().toISOString().slice(0, 10);
  if (weeklySummariesGeneratedOn === today) return; // una volta al giorno basta e avanza

  const newWeekly = {};
  for (const cat of Object.keys(CATEGORY_LABELS)) {
    const days = dailyArchive[cat] || [];
    const text = await summarizeWeek(cat, days);
    await sleep(3000);
    const sentiment = await classifyTextSentiment(text);
    await sleep(3000);
    newWeekly[cat] = { text, daysCovered: days.length, sentiment };
  }
  weeklySummaries = newWeekly;
  weeklySummariesGeneratedOn = today;
  console.log('[orion] riepilogo settimanale aggiornato, giorni in archivio:',
    Object.fromEntries(Object.entries(dailyArchive).map(([k, v]) => [k, v.length])));
}

// ---------------------------------------------------------------------------
// 2d. BOLLINO DI SENTIMENT — per ogni notizia, chiediamo a Groq se il tono è
// rialzista/ribassista/neutro. Una chiamata sola per categoria (non una per
// articolo), per tenere basso il numero di chiamate a Groq.
// Se Groq risponde in un formato inatteso o con un'etichetta non valida,
// quella notizia resta senza bollino invece di mostrare qualcosa di sbagliato.
// ---------------------------------------------------------------------------
const VALID_SENTIMENTS = ['rialzista', 'ribassista', 'neutro'];

async function classifySentiment(articles) {
  if (!articles.length) return;
  const batch = articles.slice(0, 10);
  const list = batch.map((a, i) => `${i}: ${a.title}`).join('\n');

  const prompt = `Classifica il tono di ciascuna di queste notizie finanziarie come "rialzista"
(positivo per il mercato/asset di cui parla), "ribassista" (negativo), o "neutro" (né l'uno né
l'altro, o puramente informativo). Rispondi SOLO con un array JSON valido, senza altro testo,
markdown o spiegazioni, in questo formato esatto: [{"i":0,"s":"rialzista"},{"i":1,"s":"neutro"}, ...]
Usa esattamente uno tra questi tre valori per "s": rialzista, ribassista, neutro.

Notizie:
${list}`;

  try {
    const raw = await callGroq(prompt, 400, 0.1);

    // il modello a volte aggiunge testo attorno al JSON nonostante l'istruzione:
    // isoliamo solo la parte tra la prima [ e l'ultima ] prima di provare a leggerlo
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('nessun array JSON trovato nella risposta');
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) throw new Error('la risposta non è un array');

    for (const item of parsed) {
      if (
        item && typeof item.i === 'number' && batch[item.i] &&
        VALID_SENTIMENTS.includes(item.s)
      ) {
        batch[item.i].sentiment = item.s;
      }
    }
  } catch (err) {
    console.warn('[orion] classificazione sentiment fallita per questo gruppo:', err.message);
    // nessun sentiment assegnato per questo gruppo: le notizie restano semplicemente senza bollino
  }
}

async function generateSentiments() {
  if (!process.env.GROQ_API_KEY) return;
  for (const cat of Object.keys(CATEGORY_LABELS)) {
    const articles = feedCache.filter((a) => a.category === cat && !a.sentiment);
    await classifySentiment(articles);
    await sleep(3000);
  }
  console.log('[orion] sentiment assegnato a', feedCache.filter((a) => a.sentiment).length, '/', feedCache.length, 'notizie');
}

// ---------------------------------------------------------------------------
// 3. CACHE IN MEMORIA — aggiornata a intervalli, letta dall'endpoint.
// Per qualcosa di più robusto (sopravvive ai riavvii del server free tier di Render)
// puoi sostituire questo array con una tabella su Supabase o un file su disco.
// ---------------------------------------------------------------------------
let feedCache = [];
let lastUpdated = null;
let lastCounts = {};

async function fetchAndUpdate() {
  const results = [];
  const countBySource = {};

  for (const feed of FEEDS) {
    try {
      const parsed = await parser.parseURL(feed.url);
      let count = 0;
      for (const item of parsed.items.slice(0, 15)) {
        results.push({
          title: item.title?.trim() || '',
          link: item.link || '',
          source: feed.source,
          publishedAt: item.isoDate || item.pubDate || new Date().toISOString(),
          summary: (item.contentSnippet || '').slice(0, 220),
          category: feed.forceCategory || categorize(item.title || ''),
        });
        count++;
      }
      countBySource[`${feed.source} (${feed.forceCategory || 'auto'})`] = count;
    } catch (err) {
      console.error(`[orion] errore feed ${feed.source} (${feed.url}):`, err.message);
      countBySource[`${feed.source} (${feed.forceCategory || 'auto'})`] = 'ERRORE: ' + err.message;
      // un feed che fallisce non deve bloccare gli altri
    }
  }

  console.log('[orion] articoli per fonte:', countBySource);
  lastCounts = countBySource;

  // dedup per link + ordina dal più recente
  const seen = new Set();
  feedCache = results
    .filter((a) => (seen.has(a.link) ? false : seen.add(a.link)))
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  lastUpdated = new Date().toISOString();
  console.log(`[orion] feed aggiornato: ${feedCache.length} articoli @ ${lastUpdated}`);

  await generateSummaries();
  await generateSentiments();
  await generateWeeklySummaries();
  await checkAndNotify();
}

// ---------------------------------------------------------------------------
// 3c. NOTIFICHE — controlla se tra le notizie nuove ce n'è qualcuna
// "importante" (parole chiave) e, se sì, la manda in notifica a chi si è
// iscritto. Tetto di 5 al giorno per non essere fastidiosi, poi si aspetta
// il giorno dopo.
// ---------------------------------------------------------------------------
async function checkAndNotify() {
  if (!pushEnabled) return;

  // primo giro dopo un riavvio del server: la lista "già notificate" è vuota,
  // quindi segniamo tutto quello che c'è già come "visto" SENZA notificare —
  // altrimenti ogni riavvio manderebbe in un colpo solo tutte le notizie
  // importanti già presenti nel feed, anche se non sono affatto nuove.
  if (!hasRunNotifyCheck) {
    feedCache.forEach((a) => { if (a.link) notifiedLinks.add(a.link); });
    hasRunNotifyCheck = true;
    console.log('[orion] primo controllo dopo il riavvio: nessuna notifica inviata, solo segnate come viste');
    return;
  }

  if (!pushSubscriptions.length) return;

  const today = new Date().toDateString();
  if (today !== dailyNotifyResetDate) {
    dailyNotifyCount = 0;
    dailyNotifyResetDate = today;
  }

  const candidates = feedCache.filter((a) => a.link && !notifiedLinks.has(a.link) && isImportant(a.title));

  for (const article of candidates) {
    if (dailyNotifyCount >= MAX_NOTIFICATIONS_PER_DAY) break;

    notifiedLinks.add(article.link);
    dailyNotifyCount++;

    const payload = JSON.stringify({
      title: `Orion — ${CATEGORY_LABELS[article.category] || article.category}`,
      body: article.title,
      url: article.link,
    });

    // manda a tutti i dispositivi iscritti; se uno risulta scaduto/disinstallato, lo rimuoviamo
    const stillValid = [];
    for (const sub of pushSubscriptions) {
      try {
        await webpush.sendNotification(sub, payload);
        stillValid.push(sub);
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          console.log('[orion] iscrizione push scaduta, rimossa');
        } else {
          console.error('[orion] errore invio notifica:', err.message);
          stillValid.push(sub); // errore temporaneo: la teniamo, riprovi al prossimo giro
        }
      }
    }
    pushSubscriptions = stillValid;
  }

  // teniamo solo gli ultimi 500 link notificati, per non far crescere la memoria all'infinito
  if (notifiedLinks.size > 500) {
    notifiedLinks = new Set([...notifiedLinks].slice(-500));
  }
}

// ---------------------------------------------------------------------------
// 4. ENDPOINT
// ---------------------------------------------------------------------------
app.get('/api/feed', (req, res) => {
  const { category } = req.query;
  const data = category ? feedCache.filter((a) => a.category === category) : feedCache;
  res.json({ updatedAt: lastUpdated, count: data.length, articles: data, summaries: categorySummaries });
});

app.get('/api/summaries', (req, res) => {
  res.json({ updatedAt: lastUpdated, summaries: categorySummaries });
});

app.get('/api/weekly-summary', (req, res) => {
  res.json({ generatedOn: weeklySummariesGeneratedOn, weekly: weeklySummaries });
});

app.get('/api/vapid-public-key', (req, res) => {
  if (!pushEnabled) return res.status(503).json({ error: 'notifiche non configurate sul server' });
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/api/subscribe', (req, res) => {
  if (!pushEnabled) return res.status(503).json({ error: 'notifiche non configurate sul server' });
  const subscription = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'iscrizione non valida' });
  }
  // evita duplicati se lo stesso dispositivo si iscrive più volte
  const alreadyThere = pushSubscriptions.some((s) => s.endpoint === subscription.endpoint);
  if (!alreadyThere) pushSubscriptions.push(subscription);
  res.json({ ok: true, totalSubscriptions: pushSubscriptions.length });
});

app.post('/api/unsubscribe', (req, res) => {
  const { endpoint } = req.body || {};
  pushSubscriptions = pushSubscriptions.filter((s) => s.endpoint !== endpoint);
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    cachedArticles: feedCache.length,
    lastUpdated,
    articoliPerFonte: lastCounts,
    riassuntiIA: process.env.GROQ_API_KEY ? 'attivi' : 'disattivi (manca GROQ_API_KEY)',
    dettaglioRiassuntiPerCategoria: categorySummaryStatus,
    sentiment: `${feedCache.filter((a) => a.sentiment).length}/${feedCache.length} notizie classificate`,
    archivioSettimanale: Object.fromEntries(Object.entries(dailyArchive).map(([k, v]) => [k, `${v.length} giorni`])),
    notifichePush: pushEnabled ? `attive (${pushSubscriptions.length} dispositivi iscritti)` : 'disattive (mancano le chiavi VAPID)',
    notificheOggi: `${dailyNotifyCount}/${MAX_NOTIFICATIONS_PER_DAY}`,
  });
});

// ---------------------------------------------------------------------------
// 5. AVVIO — fetch immediato + refresh periodico ogni 20 minuti
// ---------------------------------------------------------------------------
const REFRESH_MS = 20 * 60 * 1000;
fetchAndUpdate();
setInterval(fetchAndUpdate, REFRESH_MS);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[orion] server avviato sulla porta ${PORT}`));
