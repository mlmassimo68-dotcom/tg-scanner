// ─────────────────────────────────────────────────────────────
// INDICATORS — calcolo tecnico lato browser (ES Module)
// ─────────────────────────────────────────────────────────────

export function ema(closes, period) {
  const k = 2 / (period + 1);
  const out = new Array(closes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  out[period - 1] = sum / period;
  for (let i = period; i < closes.length; i++)
    out[i] = closes[i] * k + out[i - 1] * (1 - k);
  return out;
}

export function sma(arr, period) {
  return arr.map((_, i) => {
    if (i < period - 1) return null;
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += arr[j];
    return s / period;
  });
}

export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let ag = 0, al = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) ag += d; else al += Math.abs(d);
  }
  ag /= period; al /= period;
  out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? Math.abs(d) : 0)) / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

export function atr(candles, period = 14) {
  const tr = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const p = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - p), Math.abs(c.low - p));
  });
  return sma(tr, period);
}

export function macd(closes, fast = 12, slow = 26, signal = 9) {
  const ef = ema(closes, fast), es = ema(closes, slow);
  const line = closes.map((_, i) => ef[i] != null && es[i] != null ? ef[i] - es[i] : null);
  const sig  = ema(line.map(v => v ?? 0), signal);
  const hist = line.map((v, i) => v != null && sig[i] != null ? v - sig[i] : null);
  return { line, signal: sig, hist };
}

export function computeScore(candles, params, weights) {
  if (candles.length < 30) return { score: 0, valid: false, isSignal: false };
  const closes  = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  const n = candles.length - 1;

  const emaF  = ema(closes, params.ema_fast);
  const emaS  = ema(closes, params.ema_slow);
  const rsiV  = rsi(closes, params.rsi_period);
  const atrV  = atr(candles, params.atr_period);
  const macdV = macd(closes);
  const volMa = sma(volumes, 20);

  if ([emaF[n], emaS[n], rsiV[n], atrV[n], macdV.hist[n], volMa[n]].some(v => v == null))
    return { score: 0, valid: false, isSignal: false };

  // Trend
  let trendCount = 0;
  for (let i = n; i >= Math.max(0, n - params.trend_bars + 1); i--)
    if (emaF[i] > emaS[i]) trendCount++;
  const trendOk = trendCount === params.trend_bars;
  const emaSep  = emaS[n] > 0 ? (emaF[n] - emaS[n]) / emaS[n] * 100 : 0;
  const scTrend = trendOk ? Math.min(emaSep / 0.5 * 100, 100) : Math.min(emaSep / 0.5 * 50, 50);

  // Momentum
  const scMom = Math.max(0, Math.min((rsiV[n] - 50) / 30 * 100, 100));

  // MACD
  const hc = macdV.hist[n], hp = macdV.hist[n - 1] ?? 0;
  const scMacd = Math.min((hc > 0 ? Math.min(hc / (atrV[n] * 0.01 + 1e-9) * 20, 80) : 0) + (hc > hp ? 20 : 0), 100);

  // Volume
  const vr = volMa[n] > 0 ? volumes[n] / volMa[n] : 1;
  const scVol = Math.max(0, Math.min((vr - 1) / (params.vol_mult - 1 + 1e-6) * 100, 100));

  // Corpo candela
  const body = Math.abs(candles[n].close - candles[n].open);
  const br   = atrV[n] > 0 ? body / atrV[n] : 0;
  let scBody = 0;
  if (candles[n].close > candles[n].open) {
    if (br >= 0.3 && br <= 1.0) scBody = 100;
    else if (br < 0.3) scBody = br / 0.3 * 100;
    else scBody = Math.max(0, 100 - (br - 1.0) / 1.5 * 100);
  }

  const wSum  = Object.values(weights).reduce((a, b) => a + b, 0);
  const score = wSum > 0
    ? (scTrend*weights.trend + scMom*weights.momentum + scMacd*weights.macd + scVol*weights.volume + scBody*weights.body) / wSum
    : 0;

  const stars = score >= 90 ? 5 : score >= 75 ? 4 : score >= 60 ? 3 : score >= 40 ? 2 : 1;

  const conds = {
    trend:  trendOk,
    rsi:    rsiV[n] >= params.rsi_min,
    macd:   hc > 0 && hc > hp,
    volume: vr >= params.vol_mult,
    candle: candles[n].close > candles[n].open,
    body:   body < atrV[n] * 3,
    score:  score >= params.score_min,
  };

  return {
    score: Math.round(score * 10) / 10,
    stars, valid: true,
    isSignal: Object.values(conds).every(Boolean),
    components: {
      trend: Math.round(scTrend), momentum: Math.round(scMom),
      macd: Math.round(scMacd),  volume: Math.round(scVol), body: Math.round(scBody),
    },
    conditions: conds,
    levels: {
      entry: candles[n].close,
      sl:    Math.round((candles[n].close - atrV[n] * params.sl_atr_mult) * 10000) / 10000,
      tp:    Math.round((candles[n].close + atrV[n] * params.sl_atr_mult * params.rr_ratio) * 10000) / 10000,
      atr:   Math.round(atrV[n] * 10000) / 10000,
    },
    indicators: {
      rsi:      Math.round(rsiV[n] * 10) / 10,
      emaFast:  Math.round(emaF[n] * 10000) / 10000,
      emaSlow:  Math.round(emaS[n] * 10000) / 10000,
      macdHist: Math.round((hc ?? 0) * 10000) / 10000,
      volRatio: Math.round(vr * 100) / 100,
    },
  };
}
