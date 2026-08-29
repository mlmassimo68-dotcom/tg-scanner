#!/usr/bin/env python3
"""
TG Scanner ML — Riaddestramento automatico settimanale
Eseguito da GitHub Actions ogni lunedì alle 10:00 IT
"""

import os, json, sys, requests, warnings
import numpy as np
import pandas as pd
import yfinance as yf
from datetime import datetime, timedelta
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.model_selection import StratifiedKFold, cross_val_score
from sklearn.pipeline import Pipeline

warnings.filterwarnings('ignore')

# ── CONFIG DA ENV ─────────────────────────────────────────────────────────────
WORKER_URL    = os.environ.get('WORKER_URL',    'https://tg-scanner.mlmassimo68.workers.dev')
CF_ACCOUNT_ID = os.environ.get('CF_ACCOUNT_ID', '')
CF_API_TOKEN  = os.environ.get('CF_API_TOKEN',  '')
CF_KV_NS_ID   = os.environ.get('CF_KV_NS_ID',  '')
TG_TOKEN      = os.environ.get('TG_TOKEN',      '')
TG_CHAT_ID    = os.environ.get('TG_CHAT_ID',    '')

YF_MAP = {
    '3QQQ':'QQQ3.L',  '3QSS':'QQQS.L',  'SXRV':'SXRV.DE', 'SXR8':'SXR8.DE',
    'DBPG':'DBPG.DE', 'DBPK':'DBPK.DE', 'LYMZ':'LYMZ.DE', '3DEL':'3DEL.L',
    '3WTI':'3OIL.L',  'QUTM':'QUTM.DE', 'WIRE':'WIRE.DE',  'HYCN':'HYCN.DE',
    'SEC0':'SEC0.DE', 'JEDI':'JEDI.DE',  'IART':'IART.DE',  'AIFS':'AIFS.DE',
    'DFEN':'DFEN.DE', 'EUNL':'EUNL.DE',  'EXS1':'EXS1.DE',  'DBPE':'DBPE.DE',
}
LEVERAGED = {'3QQQ','3QSS','DBPG','DBPK','3DEL','3WTI'}

FEATURE_COLS = [
    'entry_score','ema_cross','ema_accel','rsi','rsi_rising','rsi_oversold',
    'rsi_div','macd_above','macd_positive','macd_cross','macd_hist_rise',
    'vol_ratio','atr_pct','body_dir','h4_trend','is_leveraged','hour_norm'
]

# ── UTILS ─────────────────────────────────────────────────────────────────────
def scalar(v):
    try:
        if hasattr(v, 'iloc'): v = v.iloc[-1]
        if hasattr(v, 'item'): return float(v.item())
        return float(v)
    except:
        return 0.0

def send_telegram(text):
    if not TG_TOKEN or not TG_CHAT_ID:
        return
    try:
        requests.post(
            f'https://api.telegram.org/bot{TG_TOKEN}/sendMessage',
            json={'chat_id': TG_CHAT_ID, 'text': text, 'parse_mode': 'HTML'},
            timeout=10
        )
    except:
        pass

def ema_s(s, p):
    return s.ewm(span=min(p, len(s)), adjust=False).mean()

def calc_rsi(s, p=14):
    d = s.diff()
    g = d.clip(lower=0).ewm(span=p, adjust=False).mean()
    l = (-d.clip(upper=0)).ewm(span=p, adjust=False).mean()
    return 100 - 100 / (1 + g / l.replace(0, np.nan))

def calc_atr(df, p=14):
    hi=df['High'].astype(float); lo=df['Low'].astype(float); cl=df['Close'].astype(float)
    tr=pd.concat([hi-lo,(hi-cl.shift()).abs(),(lo-cl.shift()).abs()],axis=1).max(axis=1)
    return tr.ewm(span=p, adjust=False).mean()

def features_from_trade_only(trade):
    label       = trade.get('label','')
    entry_score = float(trade.get('entryScore') or 50)
    entry_ts    = datetime.fromtimestamp(trade['entryTime'] / 1000)
    s           = entry_score / 100.0
    return {
        'label': label,
        'entry_score':    entry_score,
        'ema_cross':      1 if s > 0.6 else 0,
        'ema_accel':      1 if s > 0.65 else 0,
        'rsi':            float(trade.get('rsi') or 50),
        'rsi_rising':     1 if s > 0.55 else 0,
        'rsi_oversold':   1 if float(trade.get('rsi') or 50) < 35 else 0,
        'rsi_div':        0,
        'macd_above':     1 if s > 0.6 else 0,
        'macd_positive':  1 if s > 0.58 else 0,
        'macd_cross':     1 if s > 0.72 else 0,
        'macd_hist_rise': 1 if s > 0.55 else 0,
        'vol_ratio':      1.5 if s > 0.65 else 1.0,
        'atr_pct':        float(trade.get('atrPct') or 0.008),
        'body_dir':       (s - 0.5) * 2,
        'h4_trend':       1 if float(trade.get('h4Score') or 50) > 55 else (
                         -1 if float(trade.get('h4Score') or 50) < 45 else 0),
        'is_leveraged':   1 if label in LEVERAGED else 0,
        'hour_norm':      max(0.0, min(1.0, (entry_ts.hour - 9) / 8)),
        'pnl_pct':        float(trade.get('pnlPct') or 0),
        'label_win':      1 if trade['status'] == 'WIN' else 0,
    }

def extract_features(trade):
    label    = trade.get('label','')
    yf_sym   = trade.get('yf') or YF_MAP.get(label)
    entry_ts = datetime.fromtimestamp(trade['entryTime'] / 1000)
    df = None
    if yf_sym:
        for days in [14, 30, 60]:
            try:
                tmp = yf.download(yf_sym,
                    start=entry_ts - timedelta(days=days),
                    end=entry_ts + timedelta(hours=4),
                    interval='1h', progress=False, auto_adjust=True)
                if isinstance(tmp.columns, pd.MultiIndex):
                    tmp.columns = tmp.columns.get_level_values(0)
                if len(tmp) >= 15:
                    df = tmp; break
            except:
                pass
    if df is None or len(df) < 10:
        return features_from_trade_only(trade)
    try:
        df_e = df[df.index <= pd.Timestamp(entry_ts, tz='UTC')]
        if len(df_e) < 10:
            df_e = df.head(max(10, len(df)//2))
        c = df_e['Close'].astype(float)
        n = len(df_e)
        e20=scalar(ema_s(c,min(20,n)).iloc[-1]); e50=scalar(ema_s(c,min(50,n)).iloc[-1])
        e20p=scalar(ema_s(c,min(20,n)).iloc[-2]) if n>=2 else e20
        e50p=scalar(ema_s(c,min(50,n)).iloc[-2]) if n>=2 else e50
        rs=calc_rsi(c,14); rc=scalar(rs.iloc[-1]); rp=scalar(rs.iloc[-2]) if n>=2 else rc
        ml=ema_s(c,12)-ema_s(c,26); ms=ema_s(ml,9); mh=ml-ms
        mv=scalar(ml.iloc[-1]); sv=scalar(ms.iloc[-1])
        mvp=scalar(ml.iloc[-2]) if n>=2 else mv; svp=scalar(ms.iloc[-2]) if n>=2 else sv
        hv=scalar(mh.iloc[-1]); hvp=scalar(mh.iloc[-2]) if n>=2 else hv
        vol=df_e['Volume'].astype(float)
        vma=scalar(vol.rolling(min(20,n)).mean().iloc[-1])
        vol_r=min(scalar(vol.iloc[-1])/vma if vma>0 else 1.0, 5.0)
        price=scalar(c.iloc[-1])
        atr_pct=scalar(calc_atr(df_e,14).iloc[-1])/price if price>0 else 0.008
        l5=df_e.tail(5)
        c5=l5['Close'].astype(float); o5=l5['Open'].astype(float)
        ranges=(l5['High'].astype(float)-l5['Low'].astype(float)).replace(0,np.nan)
        body_dir=scalar(((c5-o5)/ranges).fillna(0).mean())
        pmx5=scalar(c.iloc[-6:-1].max()) if n>=6 else price
        rmx5=scalar(rs.iloc[-6:-1].max()) if n>=6 else rc
        rsi_div=1 if (price>pmx5 and rc<rmx5) else 0
        df_h4=df_e.resample('4h').agg({'Open':'first','High':'max','Low':'min','Close':'last','Volume':'sum'}).dropna()
        h4t=0
        if len(df_h4)>=3:
            c4=df_h4['Close'].astype(float)
            e20h=scalar(ema_s(c4,min(20,len(c4))).iloc[-1])
            e50h=scalar(ema_s(c4,min(50,len(c4))).iloc[-1])
            h4t=1 if e20h>e50h else -1
        entry_ts2=datetime.fromtimestamp(trade['entryTime']/1000)
        hour_norm=max(0.0,min(1.0,(entry_ts2.hour-9)/8))
        return {
            'label': label,
            'entry_score': float(trade.get('entryScore') or 50),
            'ema_cross':1 if e20>e50 else 0,'ema_accel':1 if (e20>e20p and e50>e50p) else 0,
            'rsi':rc,'rsi_rising':1 if rc>rp else 0,'rsi_oversold':1 if rc<35 else 0,'rsi_div':rsi_div,
            'macd_above':1 if mv>sv else 0,'macd_positive':1 if mv>0 else 0,
            'macd_cross':1 if (mvp<=svp and mv>sv) else 0,'macd_hist_rise':1 if hv>hvp else 0,
            'vol_ratio':vol_r,'atr_pct':atr_pct,'body_dir':body_dir,
            'h4_trend':h4t,'is_leveraged':1 if label in LEVERAGED else 0,'hour_norm':hour_norm,
            'pnl_pct':float(trade.get('pnlPct') or 0),
            'label_win':1 if trade['status']=='WIN' else 0,
        }
    except:
        return features_from_trade_only(trade)

# ── MAIN ─────────────────────────────────────────────────────────────────────
def main():
    now = datetime.now().strftime('%d/%m/%Y %H:%M')
    print(f'[{now}] TG Scanner ML Retrain avviato')

    # 1. Scarica storico
    print('Scarico storico dal worker...')
    resp = requests.get(f'{WORKER_URL}/history', timeout=15)
    trades_raw = resp.json()
    trades = [t for t in trades_raw
              if t.get('entryPrice') and t.get('exitPrice')
              and t.get('status') in ('WIN','LOSS')]
    print(f'Trade utilizzabili: {len(trades)}')

    if len(trades) < 20:
        msg = f'⚠️ <b>ML Retrain</b> — Solo {len(trades)} trade nello storico. Riaddestramento saltato (minimo 20).'
        send_telegram(msg)
        print('Trade insufficienti, uscita.')
        sys.exit(0)

    # 2. Estrai feature
    print('Calcolo feature...')
    records = []
    for i, t in enumerate(trades):
        feat = extract_features(t)
        if feat:
            records.append(feat)
            print(f'  [{i+1}/{len(trades)}] {t.get("label","?")} {t.get("status","")} ✅')

    df_ml = pd.DataFrame(records)
    print(f'Dataset: {len(df_ml)} campioni')

    if len(df_ml) < 20:
        send_telegram(f'⚠️ <b>ML Retrain</b> — Dataset finale solo {len(df_ml)} campioni. Skip.')
        sys.exit(0)

    # 3. Addestra
    X = df_ml[FEATURE_COLS].values
    y = df_ml['label_win'].values
    wins = y.sum()
    print(f'WIN: {wins}  LOSS: {len(y)-wins}  WR: {wins/len(y)*100:.1f}%')

    n_splits = min(5, max(3, len(X) // 8))
    cv = StratifiedKFold(n_splits=n_splits, shuffle=True, random_state=42)
    pipeline = Pipeline([
        ('scaler', StandardScaler()),
        ('clf', LogisticRegression(C=0.5, class_weight='balanced', max_iter=500, random_state=42))
    ])
    scores_acc = cross_val_score(pipeline, X, y, cv=cv, scoring='accuracy')
    scores_auc = cross_val_score(pipeline, X, y, cv=cv, scoring='roc_auc')
    pipeline.fit(X, y)

    acc = scores_acc.mean()
    auc = scores_auc.mean()
    print(f'Accuracy: {acc:.3f}  AUC: {auc:.3f}')

    # 4. Esporta JSON
    scaler = pipeline.named_steps['scaler']
    clf    = pipeline.named_steps['clf']
    model_json = {
        'version':       '1.0',
        'trained_at':    datetime.now().isoformat(),
        'n_samples':     len(X),
        'n_features':    len(FEATURE_COLS),
        'feature_names': FEATURE_COLS,
        'cv_accuracy':   float(acc),
        'cv_auc':        float(auc),
        'scaler_mean':   scaler.mean_.tolist(),
        'scaler_std':    scaler.scale_.tolist(),
        'coef':          clf.coef_[0].tolist(),
        'intercept':     float(clf.intercept_[0]),
        'threshold':     0.60,
    }
    with open('tg_scanner_model.json', 'w') as f:
        json.dump(model_json, f, indent=2)
    print('Modello salvato: tg_scanner_model.json')

    # 5. Carica su KV
    if CF_ACCOUNT_ID and CF_API_TOKEN and CF_KV_NS_ID:
        url = (f'https://api.cloudflare.com/client/v4/accounts/{CF_ACCOUNT_ID}'
               f'/storage/kv/namespaces/{CF_KV_NS_ID}/values/ml_model')
        r = requests.put(url,
            headers={'Authorization': f'Bearer {CF_API_TOKEN}', 'Content-Type': 'application/json'},
            data=json.dumps(model_json), timeout=15)
        if r.status_code == 200:
            print('✅ Modello caricato su KV')
            kv_ok = True
        else:
            print(f'❌ Errore KV: {r.status_code} {r.text[:100]}')
            kv_ok = False
    else:
        print('KV non configurato')
        kv_ok = False

    # 6. Notifica Telegram
    status = '✅ caricato su KV' if kv_ok else '⚠️ non caricato su KV'
    msg = (
        f'🤖 <b>ML Retrain completato</b>\n\n'
        f'📅 {now}\n'
        f'📊 Trade: {len(X)} (WIN:{wins} LOSS:{len(y)-wins})\n'
        f'🎯 Accuracy: {acc:.1%}\n'
        f'📈 AUC: {auc:.3f}\n'
        f'💾 Modello: {status}\n\n'
        f'#TGScanner #MLRetrain'
    )
    send_telegram(msg)
    print('Notifica Telegram inviata')
    print('✅ Riaddestramento completato')

if __name__ == '__main__':
    main()
