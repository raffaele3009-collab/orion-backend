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
  // --- CRYPTO: fonti dedicate solo a crypto, categoria certa ---
  { url: 'https://www.investing.com/rss/cryptocurrency_news.rss', source: 'Investing.com', forceCategory: 'crypto' },
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', source: 'CoinDesk', forceCategory: 'crypto' },
  { url: 'https://cointelegraph.com/rss', source: 'CoinTelegraph', forceCategory: 'crypto' },

  // --- FOREX: fonti dedicate solo a valute ---
  { url: 'https://www.investing.com/rss/forex_news.rss', source: 'Investing.com', forceCategory: 'forex' },
  { url: 'https://www.fxstreet.com/rss/news', source: 'FXStreet', forceCategory: 'forex' },
  { url: 'https://www.dailyfx.com/feeds/all', source: 'DailyFX', forceCategory: 'forex' },

  // --- MATERIE PRIME: fonti dedicate a petrolio/oro/commodities ---
  { url: 'https://www.investing.com/rss/commodities_news.rss', source: 'Investing.com', forceCategory: 'materie' },
  { url: 'https://oilprice.com/rss/main', source: 'OilPrice.com', forceCategory: 'materie' },

  // --- AZIONI: borsa/mercati azionari ---
  { url: 'https://www.investing.com/rss/stock_market_news.rss', source: 'Investing.com', forceCategory: 'azioni' },
  { url: 'https://www.marketwatch.com/rss/topstories', source: 'MarketWatch', forceCategory: 'azioni' },
  { url: 'https://www.milanofinanza.it/rss/borsa', source: 'Milano Finanza', forceCategory: 'azioni' },

  // --- OBBLIGAZIONI: BTP, bond, spread ---
  { url: 'https://www.investing.com/rss/bonds_news.rss', source: 'Investing.com', forceCategory: 'obbligazioni' },
  { url: 'https://www.milanofinanza.it/rss/obbligazioni', source: 'Milano Finanza', forceCategory: 'obbligazioni' },

  // --- MACRO: indicatori, banche centrali, economia generale ---
  { url: 'https://www.investing.com/rss/news_301.rss', source: 'Investing.com', forceCategory: 'macro' },
  { url: 'https://www.ansa.it/sito/notizie/economia/economia_rss.xml', source: 'ANSA Economia', forceCategory: 'macro' },
  { url: 'https://www.ilsole24ore.com/rss/finanza.xml', source: 'Il Sole 24 Ore', forceCategory: 'macro' },

  // --- fonti generaliste: qui NON conosciamo l'argomento in anticipo, quindi
  // resta il matching per parole chiave (bilingue) come ripiego ---
  { url: 'https://feeds.reuters.com/reuters/businessNews', source: 'Reuters' },
  { url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', source: 'CNBC Markets' },
  { url: 'https://finance.yahoo.com/news/rssindex', source: 'Yahoo Finance' },
];
// IMPORTANTE: apri ogni URL nel browser prima di fidartene — sono gli indirizzi
// pubblici più comuni per queste testate, ma i siti li cambiano senza preavviso.
// Se uno smette di funzionare, i log di Render te lo segnalano (vedi sotto) e gli
// altri feed continuano comunque a funzionare senza bloccarsi a vicenda.

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
}

// ---------------------------------------------------------------------------
// 4. ENDPOINT
// ---------------------------------------------------------------------------
app.get('/api/feed', (req, res) => {
  const { category } = req.query;
  const data = category ? feedCache.filter((a) => a.category === category) : feedCache;
  res.json({ updatedAt: lastUpdated, count: data.length, articles: data });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, cachedArticles: feedCache.length, lastUpdated, articoliPerFonte: lastCounts });
});

// ---------------------------------------------------------------------------
// 5. AVVIO — fetch immediato + refresh periodico ogni 20 minuti
// ---------------------------------------------------------------------------
const REFRESH_MS = 20 * 60 * 1000;
fetchAndUpdate();
setInterval(fetchAndUpdate, REFRESH_MS);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[orion] server avviato sulla porta ${PORT}`));
