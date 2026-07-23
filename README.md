# Orion — backend feed

Piccolo server Express che scarica gli RSS delle testate finanziarie, li categorizza
(macro / azioni / crypto / forex / obbligazioni / materie) e li serve come JSON.

## Deploy su Render

1. Crea un nuovo **Web Service** su Render, collegato a questa cartella/repo.
2. Build command: `npm install`
3. Start command: `node server.js` (o lascia `npm start`, punta comunque a `server.js`)
4. Non servono variabili d'ambiente per partire — `PORT` la gestisce già Render.
5. Dopo il deploy, testa: `https://<il-tuo-servizio>.onrender.com/api/health`

## Endpoint

- `GET /api/feed` → tutti gli articoli in cache, più recenti prima
- `GET /api/feed?category=crypto` → filtrato per categoria
- `GET /api/health` → stato + numero articoli in cache + ultimo aggiornamento

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
