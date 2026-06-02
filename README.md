# TG Scanner — Serverless PWA (Yahoo Finance edition)

Scanner long-only per ETP Xetra/Tradegate.  
Nessun server, nessuna API key, zero costi.  
Prezzi via **Yahoo Finance** (gratuito, ritardo ~15 min — sufficiente per segnali daily).

---

## File inclusi

```
index.html      ← app principale
app.js          ← logica scanner, fetch Yahoo Finance, trading
indicators.js   ← EMA, RSI, MACD, ATR, scoring
manifest.json   ← configurazione PWA
sw.js           ← service worker (installazione offline)
README.md       ← questa guida
```

---

## Attivazione su GitHub Pages (5 minuti)

### 1. Crea il repository
- Vai su [github.com](https://github.com) → **New repository**
- Nome: `tg-scanner` (o qualsiasi nome)
- Visibilità: **Public** ← obbligatorio per GitHub Pages gratuito
- Clicca **Create repository**

### 2. Carica i file
- Nel repo appena creato clicca **Add file → Upload files**
- Trascina tutti i 6 file dello zip (non la cartella, i file dentro)
- Clicca **Commit changes**

### 3. Attiva GitHub Pages
- Nel repo vai su **Settings → Pages** (menu laterale sinistro)
- Source: **Deploy from a branch**
- Branch: **main** / cartella: **/ (root)**
- Clicca **Save**
- Dopo 1-2 minuti l'app è live su:  
  `https://TUOUSERNAME.github.io/NOMEREPO`

### 4. Primo avvio
- Apri l'URL sopra nel browser
- L'app parte automaticamente e carica la storia dei ticker (~5 secondi)
- Vai nel tab **⚙️ Setup** e inserisci:
  - **Telegram Bot Token** (da [@BotFather](https://t.me/BotFather))
  - **Telegram Chat ID** (usa [@userinfobot](https://t.me/userinfobot))
  - Capitale, Rischio %, R:R, Killzones
- Clicca **💾 Salva e Avvia**

---

## ⚠️ Problema "devo reinserire i dati ogni giorno"

La configurazione viene salvata nel `localStorage` del browser,  
che è legato all'URL esatto dell'app. Si perde se:

- Apri l'app da un URL diverso (es. con o senza `index.html` finale)
- Usi la modalità **Incognito / Privata**
- Il browser è impostato per cancellare i dati alla chiusura
- Hai reinstallato o aggiornato il browser

### ✅ Soluzione: usa Esporta / Importa config

Dopo aver configurato tutto la prima volta:

1. Tab **⚙️ Setup** → clicca **📋 Esporta config**
2. Salva il file `tgscanner-config-YYYY-MM-DD.json` in un posto sicuro  
   (es. Google Drive, cartella locale, email a te stesso)
3. La prossima volta che la configurazione è sparita:  
   Tab **⚙️ Setup** → **📂 Importa config** → scegli il file JSON
4. L'app riparte automaticamente con tutti i tuoi dati

> Il file JSON contiene Token Telegram e Chat ID — trattalo come una password.

---

## Installa come app (consigliato)

### Firefox Android
Menu **≡ → Installa → Aggiungi a schermata home**  
L'app si apre a schermo intero come un'app nativa.

### Chrome Android
Menu **⋮ → Aggiungi a schermata Home**

### Firefox / Chrome Desktop
Cerca l'icona di installazione nella barra degli indirizzi (⊕ o simile).

---

## Ticker monitorati

| Simbolo | Yahoo Finance | Exchange | Leva |
|---------|--------------|----------|------|
| 3QQQ | 3QQQ.DE | XETRA | 3× |
| US9L | US9L.DE | XETRA | 3× |
| DBPG | DBPG.DE | XETRA | 3× |
| LYMZ | LYMZ.DE | XETRA | 3× |
| 3DEL | 3DEL.DE | XETRA | 3× |
| 3WTI | 3WTI.DE | XETRA | 3× |
| QUTM | QUTM.DE | XETRA | — |
| WIRE | WIRE.DE | XETRA | — |
| HYCN | HYCN.DE | XETRA | — |
| SEC0 | SEC0.DE | XETRA | — |

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
- Le notifiche **Telegram** arrivano anche a pagina chiusa (inviate dal browser al momento del segnale)
- Tutti i dati (token, trades, config) restano **solo sul tuo dispositivo**
- Zero server, zero abbonamenti, zero carta di credito
