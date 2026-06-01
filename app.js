// ─────────────────────────────────────────────────────────────
// TG SCANNER SERVERLESS — app.js
// Twelve Data chiamato direttamente dal browser
// Notifiche via Telegram Bot API
// ─────────────────────────────────────────────────────────────
import { computeScore } from './indicators.js';

// ══ CONFIGURAZIONE DEFAULT ═══════════════════════════════════
const DEFAULT_CFG = {
  tdKey:      '',          // Twelve Data API key
  tgToken:    '',          // Telegram Bot token
  tgChatId:   '',          // Telegram chat_id
  capital:    10000,
  risk:       1.0,
  rr:         2.0,
  kz1s: '09:00', kz1e: '11:00',
  kz2s: '15:30', kz2e: '17:30',
  tsStop: '17:30',
  interval: 60,            // secondi tra fetch
  scoreMIn: 60,
  tickers: [
    { sym:'3QQQ', td:'3QQQ:XETRA', leva:true  },
    { sym:'US9L', td:'US9L:XETRA', leva:true  },
    { sym:'DBPG', td:'DBPG:XETRA', leva:true  },
    { sym:'LYMZ', td:'LYMZ:XETRA', leva:true  },
    { sym:'3DEL', td:'3DEL:XETRA', leva:true  },
    { sym:'3WTI', td:'3WTI:XETRA', leva:true  },
    { sym:'QUTM', td:'QUTM:XETRA', leva:false },
    { sym:'WIRE', td:'WIRE:XETRA', leva:false },
    { sym:'HYCN', td:'HYCN:XETRA', leva:false },
    { sym:'SEC0', td:'SEC0:XETRA', leva:false },
  ],
};

const SCORE_WEIGHTS = { trend:25, momentum:20, macd:20, volume:20, body:15 };
const INDICATOR_PARAMS = {
  ema_fast:8, ema_slow:21, rsi_period:14, rsi_min:60,
  vol_mult:1.5, atr_period:14, sl_atr_mult:1.5, rr_ratio:2.0,
  trend_bars:2, score_min:60,
};

const LS_KEY = 'tgscanner_sl_v1';

// ══ STATO GLOBALE ════════════════════════════════════════════
let cfg       = { ...DEFAULT_CFG };
let tickerData = {};   // sym → { candles, quote, scoring, lastUpdated }
let trades     = {};   // sym → trade aperto
let prevSignals = {};  // sym → bool (per rilevare nuovi segnali)
let refreshTimer = null;
let isLoading   = false;

// ══ PERSISTENZA ══════════════════════════════════════════════
function saveState() {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ cfg, trades })); } catch(e) {}
}
function loadState() {
  try {
    const d = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    if (d?.cfg)    cfg    = { ...DEFAULT_CFG, ...d.cfg, tickers: d.cfg.tickers || DEFAULT_CFG.tickers };
    if (d?.trades) trades = d.trades;
  } catch(e) {}
}

// ══ TEMPO ROMA ═══════════════════════════════════════════════
function romeNow()  { return new Date(new Date().toLocaleString('en-US', { timeZone:'Europe/Rome' })); }
function romeHHMM() { const t = romeNow(); return t.getHours()*100+t.getMinutes(); }
function parseHHMM(s) { const [h,m]=s.split(':').map(Number); return h*100+m; }
function fmtRome()  { const t=romeNow(); return `${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}`; }
function fmtFull()  { const t=romeNow(); return `${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}:${String(t.getSeconds()).padStart(2,'0')}`; }

function isKZ() {
  const hm = romeHHMM();
  const kz1 = hm >= parseHHMM(cfg.kz1s) && hm < parseHHMM(cfg.kz1e);
  const kz2 = hm >= parseHHMM(cfg.kz2s) && hm < parseHHMM(cfg.kz2e);
  return kz1 || kz2;
}
function isTS()    { return romeHHMM() >= parseHHMM(cfg.tsStop); }
function kzName()  {
  const hm = romeHHMM();
  if (hm >= parseHHMM(cfg.kz1s) && hm < parseHHMM(cfg.kz1e)) return 'London Open';
  if (hm >= parseHHMM(cfg.kz2s) && hm < parseHHMM(cfg.kz2e)) return 'NY Open';
  return null;
}

// ══ TWELVE DATA FETCH ════════════════════════════════════════
const TD_BASE = 'https://api.twelvedata.com';

async function tdGet(path, params) {
  if (!cfg.tdKey) throw new Error('API key mancante — vai in Setup');
  const url = new URL(TD_BASE + path);
  url.searchParams.set('apikey', cfg.tdKey);
  for (const [k,v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const data = await res.json();
  if (data.code && data.code !== 200) throw new Error(`TD ${data.code}: ${data.message}`);
  return data;
}

async function fetchHistory(tdSym) {
  const data = await tdGet('/time_series', { symbol:tdSym, interval:'1day', outputsize:60, order:'ASC', dp:4 });
  if (!data.values?.length) throw new Error('nessuna serie storica');
  return data.values.map(v => ({
    date: v.datetime,
    open: +v.open, high: +v.high, low: +v.low, close: +v.close, volume: +v.volume||0,
  }));
}

async function fetchBatchQuotes() {
  // Twelve Data free: batch multi-symbol conta N call (una per ticker)
  // Soluzione: 1 singola chiamata batch, poi parse individuale
  // Se 429, fallback a chiamate singole con delay
  const syms = cfg.tickers.map(t => t.td).join(',');
  const out  = {};
  try {
    const data = await tdGet('/quote', { symbol: syms, dp: 4 });
    for (const tk of cfg.tickers) {
      const raw = cfg.tickers.length === 1 ? data : data[tk.td];
      if (!raw || raw.code) { out[tk.sym] = null; continue; }
      out[tk.sym] = {
        price:     +raw.close,
        open:      +raw.open,
        prevClose: +raw.previous_close,
        changePct: +raw.percent_change,
        volume:    +raw.volume||0,
        high:      +raw.high,
        low:       +raw.low,
      };
    }
  } catch(e) {
    if (e.message.includes('429')) {
      // Fallback: chiamate singole con pausa 8s
      setStatus('Rate limit — aggiornamento singolo ticker...');
      for (const tk of cfg.tickers) {
        try {
          const data = await tdGet('/quote', { symbol: tk.td, dp: 4 });
          out[tk.sym] = {
            price:     +data.close,
            open:      +data.open,
            prevClose: +data.previous_close,
            changePct: +data.percent_change,
            volume:    +data.volume||0,
            high:      +data.high,
            low:       +data.low,
          };
        } catch(e2) { out[tk.sym] = null; }
        await sleep(8000);
      }
    } else { throw e; }
  }
  return out;
}

// ══ TELEGRAM ═════════════════════════════════════════════════
async function tgSend(msg) {
  if (!cfg.tgToken || !cfg.tgChatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${cfg.tgToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.tgChatId, text: msg, parse_mode: 'HTML' }),
    });
  } catch(e) { console.warn('Telegram:', e.message); }
}

// ══ CICLO PRINCIPALE ════════════════════════════════════════
async function loadAllHistory() {
  // Free plan Twelve Data: 8 call/min → pausa 10s tra ogni chiamata
  const DELAY = 10000;
  const total = cfg.tickers.length;
  setStatus(`Caricamento storia ${total} ticker (~${Math.round(total*DELAY/1000)}s)...`);
  for (let i = 0; i < total; i++) {
    const tk = cfg.tickers[i];
    try {
      const candles = await fetchHistory(tk.td);
      tickerData[tk.sym] = { candles, quote:null, scoring:null, lastUpdated:null, error:null };
      setStatus(`✅ ${tk.sym} (${i+1}/${total}) caricato`);
    } catch(e) {
      if (e.message.includes('429')) {
        setStatus(`⏳ Rate limit ${tk.sym}, attendo 35s...`);
        await sleep(35000);
        try {
          const candles = await fetchHistory(tk.td);
          tickerData[tk.sym] = { candles, quote:null, scoring:null, lastUpdated:null, error:null };
          setStatus(`✅ ${tk.sym} (${i+1}/${total}) retry ok`);
        } catch(e2) {
          tickerData[tk.sym] = { candles:[], quote:null, scoring:null, lastUpdated:null, error:e2.message };
          setStatus(`⚠️ ${tk.sym}: ${e2.message}`);
        }
      } else {
        tickerData[tk.sym] = { candles:[], quote:null, scoring:null, lastUpdated:null, error:e.message };
        setStatus(`⚠️ ${tk.sym}: ${e.message}`);
      }
    }
    if (i < total - 1) await sleep(DELAY);
  }
}

async function updateCycle() {
  if (isLoading || !cfg.tdKey) return;
  isLoading = true;
  try {
    const quotes = await fetchBatchQuotes();
    for (const tk of cfg.tickers) {
      const td = tickerData[tk.sym];
      if (!td) continue;
      const q = quotes[tk.sym];
      if (!q) { if (td) td.error = 'quota non disponibile'; continue; }

      // Aggiorna ultima candela con il prezzo live
      if (td.candles.length > 0) {
        const last = td.candles[td.candles.length - 1];
        last.close  = q.price;
        if (q.high > last.high) last.high = q.high;
        if (q.low  < last.low)  last.low  = q.low;
        last.volume = q.volume || last.volume;
      }

      td.quote       = q;
      td.scoring     = td.candles.length >= 30 ? computeScore(td.candles, INDICATOR_PARAMS, SCORE_WEIGHTS) : null;
      td.lastUpdated = Date.now();
      td.error       = null;

      // Rilevamento nuovo segnale
      const wasSignal = prevSignals[tk.sym] === true;
      const isSignal  = td.scoring?.isSignal === true;
      prevSignals[tk.sym] = isSignal;

      if (isSignal && !wasSignal && isKZ() && !isTS() && !trades[tk.sym]) {
        await onNewSignal(tk, td.scoring, q);
      }
      // Time stop su trade aperto
      if (isTS() && trades[tk.sym] && !trades[tk.sym].tsAlerted) {
        trades[tk.sym].tsAlerted = true;
        const pct = trades[tk.sym] ? (q.price - trades[tk.sym].entry) / trades[tk.sym].entry * 100 : 0;
        await tgSend(`⏰ <b>TIME STOP — ${tk.sym}</b>\nChiudi entro le ${cfg.tsStop} Roma!\nP&L: ${pct>=0?'+':''}${pct.toFixed(2)}%`);
        vibrate();
      }
    }
    renderAll();
  } catch(e) {
    setStatus('⚠️ Errore fetch: ' + e.message);
  } finally {
    isLoading = false;
  }
}

async function onNewSignal(tk, scoring, quote) {
  const { score, stars, levels, indicators } = scoring;
  const st = '★'.repeat(stars)+'☆'.repeat(5-stars);
  const t  = fmtRome();
  await tgSend(
    `🟢 <b>SEGNALE LONG — ${tk.sym}</b>\n${st} <b>${score}pt</b>\n\n` +
    `📍 Entry: <code>${levels.entry.toFixed(4)}</code>\n` +
    `🛑 SL: <code>${levels.sl.toFixed(4)}</code>\n` +
    `🎯 TP: <code>${levels.tp.toFixed(4)}</code>\n` +
    `RSI ${indicators?.rsi} · Vol ${indicators?.volRatio}x\n⏰ ${t} Roma · KZ ${kzName()}`
  );
  vibrate();
  // Notifica browser (se permesso concesso)
  if (Notification.permission === 'granted') {
    new Notification(`🟢 ${tk.sym} — SEGNALE LONG`, {
      body: `${st} ${score}pt · Entry ${levels.entry.toFixed(4)} · SL ${levels.sl.toFixed(4)}`,
      icon: '/icon-192.png',
    });
  }
}

function vibrate() { if (navigator.vibrate) navigator.vibrate([200,100,200]); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function startLoop() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(updateCycle, cfg.interval * 1000);
}

// ══ HELPERS UI ════════════════════════════════════════════════
function scoreColor(s) {
  if (s >= 75) return 'var(--green)';
  if (s >= 60) return 'var(--yellow)';
  if (s >= 40) return 'var(--orange)';
  return 'var(--red)';
}
function toStars(s) { const n=s>=90?5:s>=75?4:s>=60?3:s>=40?2:1; return '★'.repeat(n)+'☆'.repeat(5-n); }
function fmt4(n)    { return typeof n==='number'?n.toFixed(4):'—'; }
function sign(n)    { return n>=0?'+':''; }
function setStatus(msg) {
  const el = document.getElementById('statusMsg');
  if (el) el.textContent = msg;
}

function posSize(entry, sl) {
  const d = Math.abs(entry - sl);
  return d > 0 ? (cfg.capital * cfg.risk / 100) / d : 0;
}

// ══ RENDER ════════════════════════════════════════════════════
function renderAll() {
  renderHeader();
  renderStatusBar();
  const active = document.querySelector('.tab-btn.active')?.dataset?.tab;
  if (active === 'scanner') renderScanner();
  if (active === 'trade')   renderTrade();
  if (active === 'score')   renderScore();
}

function renderHeader() {
  document.getElementById('hdrTime').textContent = fmtFull();
  const kzA = isKZ(), tsA = isTS();
  const pill = document.getElementById('kzPill');
  if (tsA)      { pill.className='kz-pill kz-stop';   pill.textContent='⏰ TIME STOP'; }
  else if (kzA) { pill.className='kz-pill kz-active'; pill.textContent='● '+kzName(); }
  else          { pill.className='kz-pill kz-off';    pill.textContent='fuori KZ'; }
  document.getElementById('lastUpdate').textContent =
    Object.keys(tickerData).length > 0 ? 'aggiornato ' + fmtFull() : '';
}

function renderStatusBar() {
  const bar = document.getElementById('statusBar');
  if (!cfg.tdKey) { bar.innerHTML='<div class="sb-item"><div class="sb-dot sb-err"></div><span>Inserisci API key nel tab ⚙️ Setup</span></div>'; return; }
  bar.innerHTML = cfg.tickers.map(tk => {
    const td = tickerData[tk.sym];
    const cls = trades[tk.sym] ? 'sb-trade' : td?.scoring?.isSignal ? 'sb-sig' : td?.error ? 'sb-err' : 'sb-ok';
    const lbl = trades[tk.sym] ? `${tk.sym} LONG` : td?.scoring?.isSignal ? `${tk.sym} SIG` : tk.sym;
    return `<div class="sb-item"><div class="sb-dot ${cls}"></div><span>${lbl}</span></div>`;
  }).join('');
}

function renderScanner() {
  const banners = document.getElementById('signalBanners');
  const grid    = document.getElementById('scannerGrid');

  // Banner segnali attivi
  const sigs = cfg.tickers.filter(tk => tickerData[tk.sym]?.scoring?.isSignal && !trades[tk.sym]);
  banners.innerHTML = sigs.map(tk => {
    const sc = tickerData[tk.sym].scoring;
    return `<div class="sig-banner" onclick="openModal('${tk.sym}')">
      <div class="sig-pulse"></div>
      <div class="sig-body">
        <div class="sig-ticker">🟢 ${tk.sym} — SEGNALE LONG</div>
        <div class="sig-det">${toStars(sc.score)} ${sc.score}pt · Entry ${fmt4(sc.levels.entry)} · SL ${fmt4(sc.levels.sl)}</div>
        <div class="sig-time">${fmtRome()} Roma${kzName() ? ' · '+kzName() : ''} · Tocca per aprire</div>
      </div>
      <div class="sig-arr">›</div>
    </div>`;
  }).join('');

  // Ticker cards
  grid.innerHTML = cfg.tickers.map((tk, i) => {
    const td    = tickerData[tk.sym];
    const q     = td?.quote;
    const sc    = td?.scoring;
    const score = sc?.score ?? 0;
    const hasSig   = sc?.isSignal && !trades[tk.sym];
    const hasTrade = !!trades[tk.sym];
    const tsWarn   = hasTrade && isTS();

    let cls = 'tcard';
    if (hasSig)   cls += ' has-signal';
    else if (tsWarn)   cls += ' ts-warn';
    else if (hasTrade) cls += ' has-trade';

    let stTxt = 'flat', stCls = 'st-flat';
    if (hasSig)   { stTxt='🟢 SEGNALE'; stCls='st-signal'; }
    else if (tsWarn)   { stTxt='⏰ CHIUDI'; stCls='st-stop'; }
    else if (hasTrade) { stTxt='📊 LONG'; stCls='st-trade'; }

    const pnl = hasTrade && q ? (() => {
      const p = (q.price - trades[tk.sym].entry) / trades[tk.sym].entry * 100;
      return `<div class="tc-chg ${p>=0?'pos':'neg'}">${sign(p)}${p.toFixed(2)}% P&L</div>`;
    })() : q ? `<div class="tc-chg ${q.changePct>=0?'pos':'neg'}">${sign(q.changePct)}${q.changePct?.toFixed(2)??'—'}%</div>` : '';

    return `<div class="${cls}" onclick="onCardClick('${tk.sym}')" style="animation-delay:${i*.04}s">
      ${hasSig ? '<div class="sig-dot-card"></div>' : ''}
      <div class="tc-top">
        <div><div class="tc-sym">${tk.sym}</div>${tk.leva?'<div class="tc-leva">3× LEVA</div>':''}</div>
        ${sc ? `<div class="tc-stars">${toStars(score)}</div>` : ''}
      </div>
      <div class="tc-price">${q ? fmt4(q.price) : td?.error ? '⚠️' : '...'}</div>
      ${pnl}
      <div class="score-row">
        <div class="score-bar-wrap"><div class="score-bar-fill" style="width:${score}%;background:${scoreColor(score)}"></div></div>
        <div class="score-num" style="color:${scoreColor(score)}">${Math.round(score)}</div>
      </div>
      <div><span class="tc-status ${stCls}">${stTxt}</span></div>
    </div>`;
  }).join('');

  // Badge tab Trade
  const n = cfg.tickers.filter(tk => trades[tk.sym]).length;
  const tb = document.getElementById('tabTrade');
  tb.querySelector('.tab-badge')?.remove();
  if (n > 0) tb.insertAdjacentHTML('beforeend', `<span class="tab-badge">${n}</span>`);
}

function renderTrade() {
  const content = document.getElementById('tradeContent');
  const open = cfg.tickers.filter(tk => trades[tk.sym]);
  if (open.length === 0) {
    content.innerHTML = `<div class="no-trade"><div class="ico">📊</div>Nessun trade aperto.<br>Attendi un segnale nel tab Scanner.</div>`;
    return;
  }
  content.innerHTML = open.map(tk => {
    const tr  = trades[tk.sym];
    const q   = tickerData[tk.sym]?.quote;
    const sc  = tickerData[tk.sym]?.scoring;
    const cur = q?.price ?? tr.entry;
    const trail = tr.trail ?? tr.sl;

    const pct  = (cur - tr.entry) / tr.entry * 100;
    const eur  = posSize(tr.entry, tr.sl) * (cur - tr.entry);
    const rr   = Math.abs(tr.sl) > 0 ? Math.abs(cur - tr.entry) / Math.abs(tr.entry - tr.sl) : 0;
    const prog = Math.max(0, Math.min(100, (cur - tr.entry) / (tr.tp - tr.entry) * 100));
    const age  = Math.round((Date.now() - tr.openTime) / 60000);
    const ps   = posSize(tr.entry, tr.sl);

    const hitTP = cur >= tr.tp, hitSL = cur <= tr.sl;
    const hitTR = cur <= trail && cur > tr.entry, hitTS = isTS();

    let actTxt, actCls;
    if (hitTS)      { actTxt='⏰ TIME STOP — CHIUDI ORA';  actCls='ax-ts'; }
    else if (hitTP) { actTxt='✅ TAKE PROFIT — VENDI';     actCls='ax-tp'; }
    else if (hitSL) { actTxt='❌ STOP LOSS — VENDI';       actCls='ax-sl'; }
    else if (hitTR) { actTxt='🔄 TRAILING STOP — VENDI';  actCls='ax-trail'; }
    else            { actTxt='📊 TRADE ATTIVO — TIENI';   actCls='ax-hold'; }

    const pc = pct>=0?'pos':'neg';
    const pg = prog>=100?'var(--green)':prog>=50?'var(--yellow)':'var(--aqua)';

    const comps = sc?.components ? Object.entries(sc.components).map(([k,v])=>
      `<div class="sb-row"><div class="sb-name">${k}</div>
       <div class="sb-bar"><div class="sb-fill" style="width:${v}%;background:${scoreColor(v)}"></div></div>
       <div class="sb-val" style="color:${scoreColor(v)}">${v}</div></div>`).join('') : '';

    return `<div class="trade-block">
      <div class="trade-hdr-card">
        <div class="th-top">
          <div>
            <div class="th-sym">${tk.sym}${tk.leva?'<span class="th-leva">3×</span>':''}</div>
            <div class="th-meta">
              <span>Score: <b style="color:var(--yellow)">${Math.round(tr.score||0)}pt ${toStars(tr.score||0)}</b></span>
              <span>Età: <b>${age}min</b></span>
            </div>
          </div>
          <div class="price-wrap">
            <div class="price-lbl">prezzo attuale</div>
            <input class="price-inp" type="number" value="${cur.toFixed(4)}"
              inputmode="decimal" step="0.0001"
              onchange="updatePrice('${tk.sym}',this.value)">
            <div class="price-hint">↑ aggiorna</div>
          </div>
        </div>
      </div>
      <div class="pnl-card ${pc}">
        <div class="pnl-pct ${pc}">${sign(pct)}${pct.toFixed(2)}%</div>
        <div class="pnl-eur ${pc}">${sign(eur)}${eur.toFixed(2)} €</div>
        <div class="pnl-sub">R:R ${rr.toFixed(2)} · target ${cfg.rr} · ${Math.round(ps)} quote · ~${Math.round(ps*cur)}€</div>
      </div>
      <div class="prog-wrap">
        <div class="prog-labels"><span style="color:var(--red)">SL ${fmt4(tr.sl)}</span><span>→TP ${Math.round(prog)}%</span><span style="color:var(--green)">TP ${fmt4(tr.tp)}</span></div>
        <div class="prog-track"><div class="prog-fill" style="width:${Math.max(1,prog)}%;background:${pg}"></div></div>
      </div>
      <div class="levels-grid">
        <div class="lv-card lc-e"><div class="lv-lbl">Entry</div><div class="lv-price">${fmt4(tr.entry)}</div><div class="lv-dist">${sign(pct)}${pct.toFixed(2)}% ora</div></div>
        <div class="lv-card lc-sl"><div class="lv-lbl">Stop Loss</div><div class="lv-price" style="color:var(--red)">${fmt4(tr.sl)}</div></div>
        <div class="lv-card lc-tp"><div class="lv-lbl">Take Profit</div><div class="lv-price" style="color:var(--green)">${fmt4(tr.tp)}</div></div>
        <div class="lv-card lc-tr"><div class="lv-lbl">Trailing</div><div class="lv-price" style="color:var(--purple)">${fmt4(trail)}</div></div>
      </div>
      <div class="action-box ${actCls}">${actTxt}</div>
      ${comps ? `<div class="score-breakdown"><div class="sb-title">Score componenti</div>${comps}</div>` : ''}
      <div class="info-rows">
        <div class="ir"><span class="lbl">Rischio max</span><span class="val">−${(cfg.capital*cfg.risk/100).toFixed(2)}€ (${cfg.risk}%)</span></div>
        <div class="ir"><span class="lbl">Esposizione</span><span class="val">~${Math.round(ps*cur)}€</span></div>
        <div class="ir"><span class="lbl">RSI</span><span class="val">${sc?.indicators?.rsi??'—'}</span></div>
        <div class="ir"><span class="lbl">KillZone</span><span class="val" style="color:${isKZ()?'var(--green)':isTS()?'var(--red)':'var(--muted)'}">${kzName()||(isTS()?'⏰ TIME STOP':'fuori KZ')}</span></div>
      </div>
      <button class="close-btn" onclick="closeTrade('${tk.sym}')">✕ CHIUDI TRADE ${tk.sym}</button>
    </div>`;
  }).join('<div style="height:1px;background:var(--border);margin:8px 0"></div>');
}

function renderScore() {
  const pg = document.getElementById('scorePage');
  const sorted = [...cfg.tickers].sort((a,b)=>(tickerData[b.sym]?.scoring?.score??0)-(tickerData[a.sym]?.scoring?.score??0));
  pg.innerHTML = sorted.map((tk,i) => {
    const sc = tickerData[tk.sym]?.scoring;
    const err = tickerData[tk.sym]?.error;
    if (!sc?.valid) return `<div class="sp-card" style="animation-delay:${i*.05}s">
      <div class="sp-top"><div class="sp-sym">${tk.sym}</div>
      <div style="font-size:10px;color:var(--muted)">${err?'⚠️ '+err:'caricamento...'}</div></div></div>`;

    const conds = sc.conditions || {};
    const labels = { trend:'Trend',rsi:'RSI',macd:'MACD',volume:'Vol',candle:'↑',body:'Corpo',score:'Score' };
    return `<div class="sp-card" style="animation-delay:${i*.05}s">
      <div class="sp-top">
        <div><div class="sp-sym">${tk.sym}${tk.leva?'<span style="font-size:9px;color:var(--orange);margin-left:4px">3×</span>':''}</div>
        <div class="sp-stars">${toStars(sc.score)}</div></div>
        <div class="sp-score" style="color:${scoreColor(sc.score)}">${Math.round(sc.score)}</div>
      </div>
      ${Object.entries(sc.components||{}).map(([k,v])=>`
        <div class="sb-row"><div class="sb-name">${k}</div>
        <div class="sb-bar"><div class="sb-fill" style="width:${v}%;background:${scoreColor(v)}"></div></div>
        <div class="sb-val" style="color:${scoreColor(v)}">${v}</div></div>`).join('')}
      <div class="cond-grid">
        ${Object.entries(conds).map(([k,v])=>`<div class="cond-pill ${v?'cp-ok':'cp-no'}">${labels[k]||k}</div>`).join('')}
      </div>
      ${sc.isSignal && !trades[tk.sym] ? `<div class="sig-banner" onclick="openModal('${tk.sym}')" style="margin-top:8px;margin-bottom:0;border-radius:6px">
        <div class="sig-pulse"></div><div class="sig-body"><div class="sig-ticker">🟢 SEGNALE</div></div><div class="sig-arr">›</div></div>` : ''}
    </div>`;
  }).join('');
}

// ══ AZIONI ════════════════════════════════════════════════════
window.onCardClick = function(sym) {
  const td = tickerData[sym];
  if (trades[sym]) { switchTab('trade'); return; }
  if (td?.scoring?.isSignal) openModal(sym);
};

let modalSym = null;
window.openModal = function(sym) {
  const td = tickerData[sym];
  modalSym = sym;
  document.getElementById('modalSym').textContent = sym;
  const lv = td?.scoring?.levels || {};
  document.getElementById('mEntry').value   = lv.entry?.toFixed(4) || '';
  document.getElementById('mSL').value      = lv.sl?.toFixed(4)    || '';
  document.getElementById('mTP').value      = lv.tp?.toFixed(4)    || '';
  document.getElementById('mScore').value   = Math.round(td?.scoring?.score || 0);
  document.getElementById('mCapital').value = cfg.capital;
  document.getElementById('modalBackdrop').classList.add('open');
};

document.getElementById('modalCloseBtn').onclick = () => document.getElementById('modalBackdrop').classList.remove('open');
document.getElementById('modalBackdrop').onclick  = e => { if (e.target===document.getElementById('modalBackdrop')) document.getElementById('modalBackdrop').classList.remove('open'); };

document.getElementById('modalConfirmBtn').onclick = async () => {
  const entry   = parseFloat(document.getElementById('mEntry').value);
  const sl      = parseFloat(document.getElementById('mSL').value);
  const tp      = parseFloat(document.getElementById('mTP').value);
  const score   = parseFloat(document.getElementById('mScore').value) || 0;
  const capital = parseFloat(document.getElementById('mCapital').value) || cfg.capital;
  if (!entry || !sl || !tp) { alert('Inserisci Entry, SL e TP'); return; }
  trades[modalSym] = { entry, sl, tp, score, capital, trail: sl, openTime: Date.now(), tsAlerted: false };
  saveState();
  document.getElementById('modalBackdrop').classList.remove('open');
  renderAll();
  switchTab('trade');
  await tgSend(`📊 <b>TRADE APERTO — ${modalSym}</b>\nEntry <code>${entry}</code> · SL <code>${sl}</code> · TP <code>${tp}</code>\n${Math.round(posSize(entry,sl))} quote · Rischio max ${(cfg.capital*cfg.risk/100).toFixed(2)}€`);
};

window.closeTrade = async function(sym) {
  if (!confirm(`Chiudere trade ${sym}?`)) return;
  const tr  = trades[sym];
  const cur = tickerData[sym]?.quote?.price ?? tr.entry;
  const pct = (cur - tr.entry) / tr.entry * 100;
  const eur = posSize(tr.entry, tr.sl) * (cur - tr.entry);
  await tgSend(`${pct>=0?'✅':'❌'} <b>TRADE CHIUSO — ${sym}</b>\nEntry ${tr.entry.toFixed(4)} → Exit ${cur.toFixed(4)}\nP&L <b>${sign(pct)}${pct.toFixed(2)}%</b> (${sign(eur)}${eur.toFixed(2)}€)`);
  delete trades[sym];
  saveState();
  renderAll();
};

window.updatePrice = function(sym, val) {
  const v = parseFloat(val);
  if (isNaN(v) || v <= 0) return;
  if (tickerData[sym]?.quote) tickerData[sym].quote.price = v;
  renderTrade();
};

// ══ TABS ══════════════════════════════════════════════════════
window.switchTab = function(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab===name));
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id==='page-'+name));
  if (name==='scanner') renderScanner();
  if (name==='trade')   renderTrade();
  if (name==='score')   renderScore();
};
document.querySelectorAll('.tab-btn').forEach(b => b.onclick = () => switchTab(b.dataset.tab));

// ══ SETUP ═════════════════════════════════════════════════════
function loadSetupUI() {
  document.getElementById('cfgTdKey').value    = cfg.tdKey;
  document.getElementById('cfgTgToken').value  = cfg.tgToken;
  document.getElementById('cfgTgChat').value   = cfg.tgChatId;
  document.getElementById('cfgCapital').value  = cfg.capital;
  document.getElementById('cfgRisk').value     = cfg.risk;
  document.getElementById('cfgRR').value       = cfg.rr;
  document.getElementById('cfgInterval').value = cfg.interval;
  document.getElementById('cfgKz1s').value     = cfg.kz1s;
  document.getElementById('cfgKz1e').value     = cfg.kz1e;
  document.getElementById('cfgKz2s').value     = cfg.kz2s;
  document.getElementById('cfgKz2e').value     = cfg.kz2e;
  document.getElementById('cfgTs').value       = cfg.tsStop;
}

document.getElementById('saveSetupBtn').onclick = async () => {
  cfg.tdKey    = document.getElementById('cfgTdKey').value.trim();
  cfg.tgToken  = document.getElementById('cfgTgToken').value.trim();
  cfg.tgChatId = document.getElementById('cfgTgChat').value.trim();
  cfg.capital  = parseFloat(document.getElementById('cfgCapital').value)||10000;
  cfg.risk     = parseFloat(document.getElementById('cfgRisk').value)||1;
  cfg.rr       = parseFloat(document.getElementById('cfgRR').value)||2;
  cfg.interval = parseInt(document.getElementById('cfgInterval').value)||60;
  cfg.kz1s     = document.getElementById('cfgKz1s').value;
  cfg.kz1e     = document.getElementById('cfgKz1e').value;
  cfg.kz2s     = document.getElementById('cfgKz2s').value;
  cfg.kz2e     = document.getElementById('cfgKz2e').value;
  cfg.tsStop   = document.getElementById('cfgTs').value;
  saveState();
  startLoop();
  // Ricarica storia se la key è nuova
  tickerData = {};
  await loadAllHistory();
  await updateCycle();
  document.getElementById('saveSetupBtn').textContent = '✓ Salvato!';
  setTimeout(()=>document.getElementById('saveSetupBtn').textContent='💾 Salva e Avvia',1500);
};

// Richiedi permesso notifiche browser
document.getElementById('notifBtn')?.addEventListener('click', async () => {
  const p = await Notification.requestPermission();
  document.getElementById('notifBtn').textContent = p==='granted' ? '✅ Notifiche attive' : '❌ Permesso negato';
});

// ══ INIT ══════════════════════════════════════════════════════
loadState();
loadSetupUI();
setInterval(renderHeader, 1000);
startLoop();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(()=>{});
}

// Avvio automatico se API key già configurata
if (cfg.tdKey) {
  setStatus('Avvio scanner...');
  loadAllHistory().then(() => {
    updateCycle();
    setStatus('');
  });
} else {
  setStatus('👆 Inserisci la tua Twelve Data API key nel tab ⚙️ Setup per iniziare');
}
