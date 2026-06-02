# TG Scanner — Serverless PWA (Yahoo Finance edition)

Scanner long-only per ETP Xetra/Tradegate.  
Nessun server, nessuna API key a pagamento, zero costi.  
Prezzi via **Yahoo Finance** (gratuito, ritardo ~15 min — sufficiente per segnali daily).

---

## File inclusi

```
index.html      ← app principale
app.js          ← logica scanner, fetch Yahoo Finance, trading
indicators.js   ← EMA, RSI, MACD, ATR, scoring
manifest.json   ← configurazione PWA
sw.js           ← service worker (installazione offline)
worker.js       ← Cloudflare Worker (proxy CORS per Yahoo Finance)
README.md       ← questa guida
```

---

## Architettura

```
Browser (GitHub Pages)
       │  fetch
       ▼
Cloudflare Worker  ← worker.js  (proxy gratuito, 100k req/giorno)
       │  fetch server-side (no CORS)
       ▼
Yahoo Finance API  (dati XETRA .DE, ritardo ~15min)
```

Il browser non può chiamare Yahoo Finance direttamente per via del blocco CORS.  
Il Worker gira su Cloudflare, chiama Yahoo server-side e restituisce i dati al browser.

---

## STEP 1 — Deploy Cloudflare Worker (5 minuti)

### 1.1 Crea account Cloudflare
- Vai su [cloudflare.com](https://cloudflare.com) → **Sign Up** (gratuito, no carta di credito)

### 1.2 Crea il Worker
- Dashboard Cloudflare → **Workers & Pages** → **Create** → **Create Worker**
- Nome: `tg-scanner` (diventerà `tg-scanner.TUOUSERNAME.workers.dev`)
- Clicca **Deploy** (lascia il codice di esempio per ora)

### 1.3 Carica il codice del Worker
- Nel Worker appena creato clicca **Edit code**
- Cancella tutto il codice esistente
- Copia e incolla il contenuto del file `worker.js` incluso nello zip
- Clicca **Deploy**

### 1.4 Annota il tuo Worker URL
- Trovi l'URL in alto nella pagina del Worker:  
  `https://tg-scanner.TUOUSERNAME.workers.dev`
- Copialo — ti serve nel Setup dell'app

> **Limite gratuito:** 100.000 richieste/giorno.  
> Con 10 ticker e aggiornamento ogni 60s → ~1.440 req/ora → ampiamente dentro il limite.

---

## STEP 2 — Deploy app su GitHub Pages (5 minuti)

### Se hai già il repo dalla versione precedente
- Vai nel repo esistente → **Add file → Upload files**
- Carica questi file (sovrascrive quelli vecchi):
  - `app.js`
  - `index.html`
  - `worker.js` ← nuovo
  - `README.md` ← aggiornato
- Clicca **Commit changes**
- Dopo 1-2 minuti GitHub Pages si aggiorna automaticamente

### Se parti da zero
1. Crea repo GitHub **Public** → nome `tg-scanner`
2. Carica tutti i 7 file nella root del repo
3. **Settings → Pages → Source: main / root → Save**
4. App live su: `https://TUOUSERNAME.github.io/tg-scanner`

---

## STEP 3 — Prima configurazione dell'app

1. Apri l'app nel browser (hard refresh: `Ctrl+Shift+R`)
2. Vai nel tab **⚙️ Setup**
3. Inserisci:
   - **Worker URL** → `https://tg-scanner.TUOUSERNAME.workers.dev`
   - **Telegram Bot Token** (da [@BotFather](https://t.me/BotFather))
   - **Telegram Chat ID** (da [@userinfobot](https://t.me/userinfobot))
   - Capitale, Rischio %, R:R, Killzones
4. Clicca **💾 Salva e Avvia**
5. L'app carica la storia dei ticker (~5 secondi) e inizia a monitorare

---

## ⚠️ Problema "devo reinserire i dati ogni giorno"

La configurazione viene salvata nel `localStorage` del browser, legato all'URL esatto.  
Si perde se usi modalità Incognita, cambi browser, o il browser cancella i dati.

### ✅ Soluzione: Esporta / Importa config

Dopo aver configurato tutto la prima volta:

1. Tab **⚙️ Setup** → **📋 Esporta config**
2. Salva il file `tgscanner-config-YYYY-MM-DD.json` in posto sicuro  
   (Google Drive, cartella locale, email a te stesso)
3. Se la config sparisce:  
   Tab **⚙️ Setup** → **📂 Importa config** → scegli il file JSON
4. L'app riparte con tutti i tuoi dati

> Il file JSON contiene il Worker URL e il Token Telegram — trattalo come una password.

---

## Installa come app (consigliato)

### Firefox Android
Menu **≡ → Installa → Aggiungi a schermata home**

### Chrome Android
Menu **⋮ → Aggiungi a schermata Home**

### Desktop (Firefox / Chrome)
Cerca l'icona di installazione (⊕) nella barra degli indirizzi.

---

## Ticker monitorati

| Simbolo | Yahoo Finance | Exchange | Leva |
|---------|--------------|----------|------|
| DBPG | DBPG.DE | XETRA | 3× |
| LYMZ | LYMZ.DE | XETRA | 3× |
| 3DEL | 3DEL.DE | XETRA | 3× |
| 3WTI | 3WTI.DE | XETRA | — |
| QUTM | QUTM.DE | XETRA | — |
| WIRE | WIRE.DE | XETRA | — |
| HYCN | HYCN.DE | XETRA | — |
| SEC0 | SEC0.DE | XETRA | — |

> 3QQQ e US9L non sono disponibili su Yahoo Finance (delisted o non indicizzati).

I trade si aprono su **Tradegate** (commissioni 0 sul tuo broker).  
I prezzi XETRA e Tradegate sono praticamente identici — spread < 0.1%.

---

## Killzones di default

| KZ | Orario Roma | Sessione |
|----|------------|----------|
| KZ1 | 09:00 – 11:00 | London Open |
| KZ2 | 15:30 – 17:30 | NY Open |
| Time Stop | 17:30 | Chiudi trade aperti |

---

## Note operative

- Tieni la pagina **aperta** durante le ore di trading per le notifiche browser
- Le notifiche **Telegram** arrivano anche a pagina chiusa
- Tutti i dati restano **solo sul tuo dispositivo**
- Zero server propri, zero abbonamenti, zero carta di credito
