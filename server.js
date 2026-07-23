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
// ---------------------------------------------------------------------------
const FEEDS = [
  { url: 'https://feeds.reuters.com/reuters/businessNews', source: 'Reuters' },
  { url: 'https://www.ilsole24ore.com/rss/finanza.xml', source: 'Il Sole 24 Ore' },
  { url: 'https://www.investing.com/rss/news_25.rss', source: 'Investing.com' },
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', source: 'CoinDesk' },
  { url: 'https://www.milanofinanza.it/rss/finanza', source: 'Milano Finanza' },
];
// NB: alcuni di questi URL potrebbero non essere più validi o richiedere User-Agent:
// verifica ogni feed nel browser prima di andare in produzione, i siti li cambiano spesso.

// ---------------------------------------------------------------------------
// 2. CATEGORIZZAZIONE — matching per parole chiave sul titolo (veloce e gratis).
// Se vuoi più precisione, sostituisci categorize() con una chiamata a Groq
// (stesso provider già usato in Clark) passando titolo+riassunto e chiedendo
// una singola parola tra le 6 categorie.
// ---------------------------------------------------------------------------
const CATEGORY_KEYWORDS = {
  crypto: ['bitcoin', 'btc', 'ethereum', 'eth', 'crypto', 'blockchain', 'token', 'defi', 'stablecoin'],
  forex: ['dollaro', 'euro', 'yen', 'sterlina', 'cambio', 'forex', 'usd/', 'eur/', 'valuta'],
  obbligazioni: ['btp', 'bond', 'obbligazion', 'spread', 'rendimento', 'treasury', 'bund'],
  materie: ['petrolio', 'brent', 'oro', 'gas naturale', 'materie prime', 'oil', 'gold', 'commodity'],
  azioni: ['borsa', 'piazza affari', 'ftse', 'nasdaq', 'wall street', 'azioni', 'trimestrale', 'utili', 'ipo'],
  macro: ['bce', 'fed', 'inflazione', 'pil', 'tassi', 'disoccupazione', 'occupazione', 'banca centrale'],
};

function categorize(title) {
  const t = title.toLowerCase();
  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((k) => t.includes(k))) return cat;
  }
  return 'macro'; // fallback di default
}

// ---------------------------------------------------------------------------
// 3. CACHE IN MEMORIA — aggiornata a intervalli, letta dall'endpoint.
// Per qualcosa di più robusto (sopravvive ai riavvii del server free tier di Render)
// puoi sostituire questo array con una tabella su Supabase o un file su disco.
// ---------------------------------------------------------------------------
let feedCache = [];
let lastUpdated = null;

async function fetchAndUpdate() {
  const results = [];

  for (const feed of FEEDS) {
    try {
      const parsed = await parser.parseURL(feed.url);
      for (const item of parsed.items.slice(0, 15)) {
        results.push({
          title: item.title?.trim() || '',
          link: item.link || '',
          source: feed.source,
          publishedAt: item.isoDate || item.pubDate || new Date().toISOString(),
          summary: (item.contentSnippet || '').slice(0, 220),
          category: categorize(item.title || ''),
        });
      }
    } catch (err) {
      console.error(`[orion] errore feed ${feed.source}:`, err.message);
      // un feed che fallisce non deve bloccare gli altri
    }
  }

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
  res.json({ ok: true, cachedArticles: feedCache.length, lastUpdated });
});

// ---------------------------------------------------------------------------
// 5. AVVIO — fetch immediato + refresh periodico ogni 20 minuti
// ---------------------------------------------------------------------------
const REFRESH_MS = 20 * 60 * 1000;
fetchAndUpdate();
setInterval(fetchAndUpdate, REFRESH_MS);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[orion] server avviato sulla porta ${PORT}`));
