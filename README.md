# TG Scanner — Serverless PWA

## File da caricare su GitHub Pages

```
index.html      ← app principale
app.js          ← logica scanner + trading
indicators.js   ← EMA, RSI, MACD, ATR, scoring
manifest.json   ← configurazione PWA
sw.js           ← service worker (installazione offline)
```

## Setup (5 minuti)

1. Crea repo GitHub PUBBLICO chiamato `tg-scanner`
2. Carica tutti questi file nella root del repo
3. Settings → Pages → Source: main / root → Save
4. App live su: https://tuousername.github.io/tg-scanner
5. Apri l'app → tab ⚙️ Setup → inserisci:
   - Twelve Data API key (da twelvedata.com, gratis)
   - Telegram Bot Token (da @BotFather)
   - Telegram Chat ID
6. Clicca "Salva e Avvia"
7. L'app carica la storia (~90 secondi) e inizia a monitorare

## Firefox Android — Installa come app
Menu ≡ → "Installa" → Aggiungi a schermata home

## Firefox Desktop
Menu ≡ → "Installa sito come app"

## Note importanti
- Tieni la pagina aperta durante le ore di trading
- Le notifiche Telegram arrivano sempre (anche a pagina chiusa)
- Le notifiche browser richiedono la pagina aperta
- Tutti i dati (API key, trades) restano sul dispositivo
- Zero server, zero costi, zero carta di credito
