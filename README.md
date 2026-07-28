# Orion — backend feed

Piccolo server Express che scarica gli RSS delle testate finanziarie, li categorizza
(macro / azioni / crypto / forex / obbligazioni / materie) e li serve come JSON.

## Deploy su Render

1. Crea un nuovo **Web Service** su Render, collegato a questa cartella/repo.
2. Build command: `npm install`
3. Start command: `node server.js` (o lascia `npm start`, punta comunque a `server.js`)
4. Non servono variabili d'ambiente per partire — `PORT` la gestisce già Render.
5. Dopo il deploy, testa: `https://<il-tuo-servizio>.onrender.com/api/health`

## Riassunto IA per categoria (novità)

Ad ogni aggiornamento del feed (ogni 20 minuti), il backend chiede a Groq (stesso
provider usato in Clark) un piccolo paragrafo che riassume le notizie del giorno
per ciascuna delle 6 categorie.

**Per attivarlo:**
1. Vai sul tuo servizio su Render → tab **Environment**
2. Aggiungi una variabile: `GROQ_API_KEY` = la tua chiave Groq (la stessa di Clark, o una nuova da console.groq.com)
3. Salva — Render riavvia da solo il servizio

Se non aggiungi questa chiave, l'app continua a funzionare normalmente: semplicemente
i riassunti restano vuoti (lo vedi anche da `/api/health`, campo `riassuntiIA`).

## Endpoint

- `GET /api/feed` → tutti gli articoli in cache, più recenti prima, **più i riassunti IA** in `summaries`
- `GET /api/feed?category=crypto` → filtrato per categoria (i riassunti restano tutti e 6, non filtrati)
- `GET /api/summaries` → solo i riassunti IA, uno per categoria
- `GET /api/health` → stato + numero articoli in cache + ultimo aggiornamento +
  quanti articoli ha preso ciascuna fonte + se i riassunti IA sono attivi

## Come aggiornare il backend dopo una modifica

Basta ricaricare il file modificato su GitHub (stessa cartella, lo sovrascrivi).
Render è collegato al repo e rifà il deploy da solo in 1-2 minuti — non serve
toccare nulla su Render stesso.

## Prossimi passi da valutare

- **Verifica i feed RSS**: alcuni URL in `FEEDS` (dentro `server.js`) potrebbero essere
  cambiati o richiedere un User-Agent — controllali uno per uno nel browser prima
  di fidarti in produzione.
- **Persistenza**: ora la cache è solo in RAM, quindi si svuota ad ogni riavvio
  (il piano free di Render "dorme" e riavvia il servizio). Se ti serve continuità,
  il prossimo step è salvare `feedCache` su Supabase o su un file, come discusso.
- **Categorizzazione più precisa**: il matching per parole chiave è veloce ma
  approssimativo. Se vuoi, sostituiamo `categorize()` con una chiamata a Groq
  (stesso provider di Clark) per farti classificare titolo+riassunto dall'AI.
- **CORS**: ora è aperto a tutti (`cors()`); quando il sito statico è online,
  meglio restringerlo con `cors({ origin: 'https://tuosito.github.io' })`.
