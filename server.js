// Orion — backend feed aggregator
// Scarica gli RSS delle testate, li categorizza (macro/azioni/crypto/forex/obbligazioni/materie)
// e li serve come JSON al frontend statico. Pensato per girare su Render, stesso pattern di ob-proxy.

const express = require('express');
const cors = require('cors');
const Parser = require('rss-parser');

const app = express();
const parser = new Parser({ timeout: 10000 });

app.use(cors()); // in produzione puoi restringere all'origine del tuo sito statico

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

async function summarizeCategory(categoryKey, articles) {
  if (!articles.length) return null;

  const bullets = articles
    .slice(0, 10)
    .map((a) => `- ${a.title}${a.summary ? ': ' + a.summary : ''}`)
    .join('\n');

  const prompt = `Sei l'assistente editoriale di un'app di notizie finanziarie chiamata Orion.
Qui sotto trovi i titoli (e riassunti) delle notizie di oggi nella categoria "${CATEGORY_LABELS[categoryKey]}".
Scrivi un paragrafo di massimo 3 frasi, in italiano, che riassuma i temi principali della giornata in questa categoria.
Tono neutro e informativo, come un notiziario. Non inventare numeri o fatti che non sono nel testo. Non usare markdown.

Notizie:
${bullets}`;

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 220,
      }),
    });
    if (!res.ok) throw new Error(`Groq status ${res.status}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.error(`[orion] errore riassunto IA per ${categoryKey}:`, err.message);
    return null;
  }
}

let categorySummaries = {};

async function generateSummaries() {
  if (!process.env.GROQ_API_KEY) {
    console.warn('[orion] GROQ_API_KEY non impostata: salto i riassunti IA.');
    return;
  }
  const newSummaries = {};
  for (const cat of Object.keys(CATEGORY_LABELS)) {
    const articles = feedCache.filter((a) => a.category === cat);
    newSummaries[cat] = await summarizeCategory(cat, articles);
  }
  categorySummaries = newSummaries;
  console.log('[orion] riassunti IA aggiornati per', Object.keys(newSummaries).filter(k => newSummaries[k]).length, 'categorie');
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

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    cachedArticles: feedCache.length,
    lastUpdated,
    articoliPerFonte: lastCounts,
    riassuntiIA: process.env.GROQ_API_KEY ? 'attivi' : 'disattivi (manca GROQ_API_KEY)',
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
