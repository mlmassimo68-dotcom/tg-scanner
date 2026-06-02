/**
 * TG Scanner — Cloudflare Worker (proxy Yahoo Finance)
 * Deploy gratuito su Cloudflare Workers (100k req/giorno free)
 *
 * Questo Worker:
 *  - Riceve richieste dal browser (bypassa CORS)
 *  - Le inoltra a Yahoo Finance server-side
 *  - Restituisce la risposta con headers CORS corretti
 */

const ALLOWED_ORIGIN_PATTERN = /\.github\.io$/;  // accetta solo GitHub Pages
const YF_BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';
const YF_BASE2 = 'https://query2.finance.yahoo.com/v8/finance/chart';

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return corsResponse(null, 204);
    }

    const origin = request.headers.get('Origin') || '';

    // Sicurezza: accetta solo richieste da GitHub Pages (o localhost per test)
    if (!ALLOWED_ORIGIN_PATTERN.test(origin) && !origin.includes('localhost') && !origin.includes('127.0.0.1')) {
      return corsResponse(JSON.stringify({ error: 'Origin non autorizzata' }), 403, origin);
    }

    const url    = new URL(request.url);
    const symbol = url.searchParams.get('symbol');
    const interval = url.searchParams.get('interval') || '1d';
    const range    = url.searchParams.get('range')    || '3mo';

    if (!symbol) {
      return corsResponse(JSON.stringify({ error: 'symbol mancante' }), 400, origin);
    }

    // Prova query1, fallback su query2
    let data;
    try {
      data = await yfFetch(YF_BASE, symbol, interval, range);
    } catch(e) {
      try {
        data = await yfFetch(YF_BASE2, symbol, interval, range);
      } catch(e2) {
        return corsResponse(JSON.stringify({ error: e2.message }), 502, origin);
      }
    }

    return corsResponse(JSON.stringify(data), 200, origin);
  }
};

async function yfFetch(base, symbol, interval, range) {
  const url = `${base}/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'application/json',
    },
    cf: { cacheTtl: 60, cacheEverything: false }  // no cache per dati live
  });
  if (!res.ok) throw new Error(`YF HTTP ${res.status}`);
  const json = await res.json();
  if (!json?.chart?.result?.[0]) {
    const err = json?.chart?.error?.description || 'nessun dato';
    throw new Error(err);
  }
  return json;
}

function corsResponse(body, status, origin) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  return new Response(body, { status: status || 200, headers });
}
