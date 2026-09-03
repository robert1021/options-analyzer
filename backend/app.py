from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pathlib import Path
import yfinance as yf
import pandas as pd
from datetime import datetime, timezone
import math

app = FastAPI(title="Options Analyzer API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def to_ts(date_str: str) -> int:
    # date_str like 2025-12-19 -> midnight UTC timestamp
    dt = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    return int(dt.timestamp())

def clean_value(v):
    if v is None:
        return None
    # pandas NA / numpy nan
    try:
        if pd.isna(v):
            return None
    except:
        pass
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return None
    # Timestamp
    if isinstance(v, pd.Timestamp):
        return int(v.timestamp())
    if hasattr(v, 'timestamp'):
        try:
            return int(v.timestamp())
        except:
            pass
    return v

def df_to_contracts(df: pd.DataFrame):
    contracts = []
    if df is None or df.empty:
        return contracts
    for _, row in df.iterrows():
        # row is Series
        c = {}
        for col in df.columns:
            val = row[col]
            # special handling for lastTradeDate
            if col == "lastTradeDate":
                try:
                    if pd.isna(val):
                        c[col] = None
                    elif isinstance(val, pd.Timestamp):
                        c[col] = int(val.timestamp())
                    else:
                        # could be string or datetime
                        ts = pd.to_datetime(val)
                        c[col] = int(ts.timestamp()) if not pd.isna(ts) else None
                except:
                    c[col] = None
            else:
                c[col] = clean_value(val)
        # ensure required fields exist
        # frontend expects contractSymbol, strike, lastPrice, change, percentChange, volume, openInterest, bid, ask, impliedVolatility, inTheMoney
        # fill missing with None
        for k in ["contractSymbol","strike","lastPrice","change","percentChange","volume","openInterest","bid","ask","impliedVolatility","inTheMoney","currency","contractSize"]:
            if k not in c:
                c[k] = None
        contracts.append(c)
    return contracts

def get_quote(ticker: yf.Ticker, symbol: str):
    quote = {"symbol": symbol.upper()}
    info = {}
    try:
        # info can be slow but try
        info = ticker.info or {}
    except Exception:
        info = {}
    # fast_info fallback
    fast = None
    try:
        fast = ticker.fast_info
    except Exception:
        fast = None

    def pick(*keys):
        for k in keys:
            if k in info and info[k] is not None:
                return info[k]
        return None

    # try to get price
    price = pick("currentPrice", "regularMarketPrice", "previousClose")
    if price is None and fast is not None:
        try:
            price = getattr(fast, "last_price", None)
            if price is None:
                price = fast.get("last_price") if isinstance(fast, dict) else None
        except:
            pass
    # fallback to history
    if price is None:
        try:
            hist = ticker.history(period="1d", interval="1m")
            if not hist.empty:
                price = float(hist["Close"].iloc[-1])
        except:
            pass

    quote["shortName"] = pick("shortName") or symbol.upper()
    quote["longName"] = pick("longName") or quote["shortName"]
    quote["regularMarketPrice"] = price
    quote["regularMarketChange"] = pick("regularMarketChange")
    quote["regularMarketChangePercent"] = pick("regularMarketChangePercent")
    # fast_info derived change if missing
    if quote["regularMarketChange"] is None and fast is not None and price is not None:
        try:
            prev = getattr(fast, "previous_close", None)
            if prev:
                quote["regularMarketChange"] = float(price) - float(prev)
                quote["regularMarketChangePercent"] = (float(price)-float(prev))/float(prev) if prev else 0
        except:
            pass
    # Normalize to fractional for frontend (frontend does *100). yfinance `info`
    # sometimes returns percent as 1.23 (=1.23%) while fast_info/history
    # derived path returns fractional 0.0123. Detect by comparing to the
    # change/prevClose implied percent when available, otherwise fall back
    # to magnitude heuristic (|pct| > 1 => likely already a percent).
    cp = quote.get("regularMarketChangePercent")
    ch = quote.get("regularMarketChange")
    pr = quote.get("regularMarketPrice")
    if cp is not None:
        try:
            cp_f = float(cp)
            # If we can compute expected fractional change, use it to decide
            if ch is not None and pr is not None:
                try:
                    prev = float(pr) - float(ch)
                    if prev:
                        expected = float(ch) / float(prev)  # fractional
                        # choose the form (cp_f vs cp_f/100) closer to expected
                        if abs(cp_f / 100.0 - expected) < abs(cp_f - expected):
                            quote["regularMarketChangePercent"] = cp_f / 100.0
                        else:
                            quote["regularMarketChangePercent"] = cp_f
                        # mark handled
                        cp = None
                except:
                    pass
            if cp is not None:
                # fallback: magnitude heuristic — e.g. -0.83 means -0.83% not -83%
                if abs(cp_f) > 1 and abs(cp_f) < 1000:
                    # values like 150 (=150%) are ambiguous with moves >100%;
                    # the expected-based branch above already handled verifiable cases,
                    # so here treat >1 as percent.
                    quote["regularMarketChangePercent"] = cp_f / 100.0
        except:
            pass

    quote["regularMarketVolume"] = pick("volume", "regularMarketVolume")
    if quote["regularMarketVolume"] is None and fast is not None:
        try:
            quote["regularMarketVolume"] = getattr(fast, "last_volume", None)
        except:
            pass
    quote["regularMarketDayHigh"] = pick("dayHigh", "regularMarketDayHigh")
    quote["regularMarketDayLow"] = pick("dayLow", "regularMarketDayLow")
    quote["fiftyTwoWeekHigh"] = pick("fiftyTwoWeekHigh")
    quote["fiftyTwoWeekLow"] = pick("fiftyTwoWeekLow")
    quote["currency"] = pick("currency") or "USD"

    # If change percent still None but we computed change
    if quote["regularMarketChangePercent"] is None and quote["regularMarketChange"] is not None and price:
        try:
            quote["regularMarketChangePercent"] = quote["regularMarketChange"] / (price - quote["regularMarketChange"]) if (price - quote["regularMarketChange"]) else 0
        except:
            pass

    # ensure numbers are clean
    for k in list(quote.keys()):
        v = quote[k]
        if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
            quote[k] = None
    return quote

@app.get("/api/health")
def health():
    return {"status": "ok"}

@app.get("/api/options")
def get_options(symbol: str = Query(..., description="Ticker like AAPL"), date: str | None = Query(None, description="Expiry YYYY-MM-DD or timestamp seconds")):
    sym = symbol.strip().upper()
    if not sym:
        raise HTTPException(400, "symbol required")
    ticker = yf.Ticker(sym)
    # get expirations
    try:
        expirations_str = list(ticker.options) if ticker.options else []
    except Exception as e:
        raise HTTPException(500, f"Failed to fetch expirations: {e}")
    if not expirations_str:
        raise HTTPException(404, f"No expirations found for {sym}. Check ticker symbol.")
    # convert to timestamps
    expirations_ts = []
    for d in expirations_str:
        try:
            expirations_ts.append(to_ts(d))
        except:
            pass
    # resolve requested date
    requested_str = None
    if date:
        # try timestamp
        try:
            # if numeric
            ts = int(float(date))
            # if timestamp plausible (> 1e9), convert to date str
            dt = datetime.fromtimestamp(ts, tz=timezone.utc)
            requested_str = dt.strftime("%Y-%m-%d")
            # ensure it's in list, if not pick closest or error
            if requested_str not in expirations_str:
                # try to find matching ts
                # date could be "2025-12-19"
                # if not found, treat date as string directly if in list
                if date in expirations_str:
                    requested_str = date
                else:
                    # try to parse date as YYYY-MM-DD
                    try:
                        dt2 = datetime.strptime(date, "%Y-%m-%d")
                        requested_str = dt2.strftime("%Y-%m-%d")
                    except:
                        pass
                    if requested_str not in expirations_str:
                        # fallback to first
                        requested_str = expirations_str[0]
            # also update ts to exact
        except ValueError:
            # treat as YYYY-MM-DD string
            if date in expirations_str:
                requested_str = date
            else:
                try:
                    dt = datetime.strptime(date, "%Y-%m-%d")
                    requested_str = dt.strftime("%Y-%m-%d")
                except:
                    requested_str = expirations_str[0]
    else:
        requested_str = expirations_str[0]

    if requested_str not in expirations_str:
        requested_str = expirations_str[0]

    requested_ts = to_ts(requested_str)

    # fetch chain
    try:
        chain = ticker.option_chain(requested_str)
        calls_df = chain.calls
        puts_df = chain.puts
    except Exception as e:
        raise HTTPException(500, f"Failed to fetch option chain for {requested_str}: {e}")

    calls = df_to_contracts(calls_df)
    puts = df_to_contracts(puts_df)

    # strikes: sorted unique strikes for this expiry
    strikes_set = set()
    for c in calls:
        if c.get("strike") is not None:
            strikes_set.add(float(c["strike"]))
    for p in puts:
        if p.get("strike") is not None:
            strikes_set.add(float(p["strike"]))
    strikes = sorted(strikes_set)

    quote = get_quote(ticker, sym)

    # Build Yahoo-like response for frontend compatibility
    result = {
        "quote": quote,
        "expirationDates": expirations_ts,
        "expirations": expirations_str,  # extra helpful
        "strikes": strikes,
        "options": [
            {
                "expirationDate": requested_ts,
                "expirationStr": requested_str,
                "hasMiniOptions": False,
                "calls": calls,
                "puts": puts,
            }
        ],
    }
    return {"optionChain": {"result": [result], "error": None}}

# Serve frontend static if exists (for single-port deployment)
dist_dir = Path(__file__).resolve().parent.parent / "dist"
if dist_dir.exists():
    app.mount("/", StaticFiles(directory=str(dist_dir), html=True), name="static")
