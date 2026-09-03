import { useEffect, useMemo, useState, useCallback } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine, Legend
} from 'recharts'
import './App.css'

type OptionContract = {
  contractSymbol: string
  strike: number
  lastPrice: number
  change: number
  percentChange: number
  volume?: number
  openInterest?: number
  bid?: number
  ask?: number
  impliedVolatility?: number
  inTheMoney?: boolean
  expiration?: number
  lastTradeDate?: number
}

type Quote = {
  symbol: string
  shortName?: string
  longName?: string
  regularMarketPrice?: number
  regularMarketChange?: number
  regularMarketChangePercent?: number
  regularMarketVolume?: number
  regularMarketDayHigh?: number
  regularMarketDayLow?: number
  fiftyTwoWeekHigh?: number
  fiftyTwoWeekLow?: number
  currency?: string
}

type YahooResult = {
  quote: Quote
  expirationDates: number[]
  strikes: number[]
  options: {
    expirationDate: number
    hasMiniOptions: boolean
    calls: OptionContract[]
    puts: OptionContract[]
  }[]
}

const EXAMPLE_TICKERS = ['AAPL','NVDA','TSLA','SPY','QQQ','MSFT','AMD','GOOGL']

function fmtNum(n?: number) {
  if (n == null || isNaN(n)) return '—'
  if (Math.abs(n) >= 1e9) return (n/1e9).toFixed(2)+'B'
  if (Math.abs(n) >= 1e6) return (n/1e6).toFixed(2)+'M'
  if (Math.abs(n) >= 1e3) return (n/1e3).toFixed(1)+'K'
  return n.toLocaleString()
}
function fmtPrice(n?: number) {
  if (n == null) return '—'
  return n.toFixed(2)
}
function fmtExpiry(ts: number) {
  const d = new Date(ts*1000)
  const iso = d.toISOString().slice(0,10)
  const days = Math.round((ts*1000 - Date.now())/86400000)
  const dstr = days === 0 ? 'today' : days === 1 ? '1d' : days>0 ? `${days}d` : `${Math.abs(days)}d ago`
  return `${iso} · ${dstr}`
}
function shortExpiry(ts:number){
  return new Date(ts*1000).toISOString().slice(0,10)
}

async function fetchYahooOptionChain(ticker: string, date?: number): Promise<YahooResult> {
  const params = new URLSearchParams({ symbol: ticker })
  if (date) params.set('date', String(date))
  const res = await fetch(`/api/options?${params.toString()}`, { headers: { 'Accept': 'application/json' } })
  if (!res.ok) {
    let msg = `HTTP ${res.status}`
    try {
      const err = await res.json()
      msg = err.detail || err.error || msg
    } catch {}
    throw new Error(msg)
  }
  const json = await res.json()
  const oc = json?.optionChain
  if (!oc) throw new Error('Malformed response')
  if (oc.error) throw new Error(typeof oc.error === 'string' ? oc.error : oc.error?.description || 'API error')
  if (!oc.result || !oc.result[0]) throw new Error('No data for this ticker')
  return oc.result[0] as YahooResult
}

type MergedRow = {
  strike: number
  callOI: number
  putOI: number
  callVol: number
  putVol: number
  callIV?: number
  putIV?: number
  call?: OptionContract
  put?: OptionContract
}

export default function App() {
  const [input, setInput] = useState('AAPL')
  const [ticker, setTicker] = useState<string | null>(null)
  const [expirations, setExpirations] = useState<number[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [quote, setQuote] = useState<Quote | null>(null)
  const [calls, setCalls] = useState<OptionContract[]>([])
  const [puts, setPuts] = useState<OptionContract[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [strikeFilter, setStrikeFilter] = useState<'all'|'near'>('near')
  const [viewMode, setViewMode] = useState<'both'|'oi'|'vol'>('both')
  const [uaThreshold, setUaThreshold] = useState<'all'|'2x'|'5x'|'10x'>('all')

  const doSearch = useCallback(async (sym: string, expiryDate?: number) => {
    const s = sym.trim().toUpperCase()
    if (!s) return
    setLoading(true); setError(null)
    try {
      const data = await fetchYahooOptionChain(s, expiryDate)
      setTicker(s)
      setQuote(data.quote)
      setExpirations(data.expirationDates || [])
      // if we requested a specific expiry, keep it else take the first available
      const expToUse = expiryDate ?? data.options?.[0]?.expirationDate ?? data.expirationDates?.[0] ?? null
      setSelected(expToUse)
      setCalls(data.options?.[0]?.calls ?? [])
      setPuts(data.options?.[0]?.puts ?? [])
    } catch (e: any) {
      setError(e?.message || 'Failed to load data. Yahoo may be rate-limiting or ticker not found.')
    } finally {
      setLoading(false)
    }
  }, [])

  // on expiry change fetch that chain
  const onExpiryChange = async (ts: number) => {
    if (!ticker) return
    setSelected(ts)
    setLoading(true); setError(null)
    try {
      const data = await fetchYahooOptionChain(ticker, ts)
      setCalls(data.options?.[0]?.calls ?? [])
      setPuts(data.options?.[0]?.puts ?? [])
      setQuote(data.quote)
    } catch (e:any) {
      setError(e?.message || 'Failed to load expiry')
    } finally {
      setLoading(false)
    }
  }

  // initial load
  useEffect(() => {
    doSearch('AAPL')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const merged: MergedRow[] = useMemo(() => {
    const map = new Map<number, MergedRow>()
    for (const c of calls) {
      map.set(c.strike, { strike: c.strike, callOI: c.openInterest ?? 0, putOI: 0, callVol: c.volume ?? 0, putVol: 0, callIV: c.impliedVolatility, call: c })
    }
    for (const p of puts) {
      const cur = map.get(p.strike)
      if (cur) {
        cur.putOI = p.openInterest ?? 0
        cur.putVol = p.volume ?? 0
        cur.putIV = p.impliedVolatility
        cur.put = p
      } else {
        map.set(p.strike, { strike: p.strike, callOI: 0, putOI: p.openInterest ?? 0, callVol: 0, putVol: p.volume ?? 0, putIV: p.impliedVolatility, put: p })
      }
    }
    return Array.from(map.values()).sort((a,b)=>a.strike-b.strike)
  }, [calls, puts])

  const spot = quote?.regularMarketPrice ?? null

  const filtered = useMemo(() => {
    if (strikeFilter === 'all' || !spot || merged.length===0) return merged
    // show ~30 strikes centered on spot
    let closestIdx = 0
    let bestDist = Infinity
    merged.forEach((r,i)=>{
      const d = Math.abs(r.strike - spot)
      if (d < bestDist){ bestDist=d; closestIdx=i }
    })
    const window = 15
    const start = Math.max(0, closestIdx - window)
    const end = Math.min(merged.length, closestIdx + window + 1)
    return merged.slice(start,end)
  }, [merged, strikeFilter, spot])

  const totals = useMemo(()=>{
    let cOI=0,pOI=0,cV=0,pV=0
    for(const r of merged){ cOI+=r.callOI; pOI+=r.putOI; cV+=r.callVol; pV+=r.putVol }
    const pcrOI = cOI ? pOI/cOI : 0
    const pcrVol = cV ? pV/cV : 0
    // max pain
    let maxPain: number | null = null
    let minPain = Infinity
    // unique strikes
    for(const settlement of merged.map(m=>m.strike)){
      let pain=0
      for(const r of merged){
        if (r.call && settlement > r.strike) pain += (settlement - r.strike)*(r.callOI)
        if (r.put && settlement < r.strike) pain += (r.strike - settlement)*(r.putOI)
      }
      if (pain < minPain){ minPain=pain; maxPain=settlement }
    }
    return {cOI,pOI,cV,pV,pcrOI,pcrVol,maxPain}
  }, [merged])

  type UARow = {
    strike: number
    side: 'Call' | 'Put'
    volume: number
    openInterest: number
    ratio: number
    isInfinite: boolean
    contract: OptionContract
  }

  function signalFor(r: UARow){
    if (r.isInfinite) return { label: 'Extreme', tier: 3, detail: 'No prior OI · 100% new' }
    if (r.ratio >= 10) return { label: 'Extreme', tier: 3, detail: '10×+  · new positioning' }
    if (r.ratio >= 5) return { label: 'Highly Unusual', tier: 2, detail: '5–10×  · strong flow' }
    if (r.ratio >= 2) return { label: 'Unusual', tier: 1, detail: '2–5×  · active' }
    return { label: 'Active', tier: 0, detail: '1–2×  · building' }
  }

  const unusual = useMemo<UARow[]>(()=>{
    const rows: UARow[] = []
    for (const m of merged){
      if (m.call){
        const vol = m.call.volume ?? 0
        const oi = m.call.openInterest ?? 0
        if (vol > 0 && vol > oi){
          const inf = oi === 0
          const ratio = inf ? Infinity : vol / oi
          rows.push({ strike: m.strike, side: 'Call', volume: vol, openInterest: oi, ratio: inf ? 999 : ratio, isInfinite: inf, contract: m.call })
        }
      }
      if (m.put){
        const vol = m.put.volume ?? 0
        const oi = m.put.openInterest ?? 0
        if (vol > 0 && vol > oi){
          const inf = oi === 0
          const ratio = inf ? Infinity : vol / oi
          rows.push({ strike: m.strike, side: 'Put', volume: vol, openInterest: oi, ratio: inf ? 999 : ratio, isInfinite: inf, contract: m.put })
        }
      }
    }
    // sort: infinite first, then ratio desc, then volume desc
    rows.sort((a,b)=>{
      if (a.isInfinite && !b.isInfinite) return -1
      if (!a.isInfinite && b.isInfinite) return 1
      if (b.ratio !== a.ratio) return b.ratio - a.ratio
      return b.volume - a.volume
    })
    return rows
  }, [merged])

  const filteredUnusual = useMemo(()=>{
    if (uaThreshold==='all') return unusual
    const min = uaThreshold==='10x' ? 10 : uaThreshold==='5x' ? 5 : 2
    return unusual.filter(r=> r.isInfinite || r.ratio >= min)
  }, [unusual, uaThreshold])

  const uaStats = useMemo(()=>{
    if (unusual.length===0) return null
    let maxR = 0
    let infCount = 0
    let c=0, p=0
    let sumR=0, cntR=0
    for(const r of unusual){
      if (r.isInfinite) infCount++
      else { maxR = Math.max(maxR, r.ratio); sumR += r.ratio; cntR++ }
      if (r.side==='Call') c++; else p++
    }
    const avgR = cntR ? sumR/cntR : 0
    const top = unusual[0]
    return { maxR, infCount, c, p, avgR, top }
  }, [unusual])

  const priceChange = quote?.regularMarketChange ?? 0
  const priceChangePctRaw = quote?.regularMarketChangePercent ?? 0
  // Backend should now return fractional (0.0083 = 0.83%), but be defensive:
  // if the value is already a percent (e.g. 0.83 = 0.83%) use it directly,
  // otherwise multiply fractional by 100. Cross-check with priceChange when possible.
  const priceChangePct = (() => {
    const raw = priceChangePctRaw
    if (raw == null || isNaN(raw as number)) return 0
    const v = Number(raw)
    // if we can compute expected, pick the representation closest to expected
    if (quote?.regularMarketPrice != null && priceChange) {
      const prev = quote.regularMarketPrice - priceChange
      if (prev) {
        const expected = priceChange / prev
        if (Math.abs(v / 100 - expected) < Math.abs(v - expected)) return v / 100
        return v
      }
    }
    return Math.abs(v) > 1 && Math.abs(v) < 1000 ? v / 100 : v
  })()

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <div className="brand-mark">◈</div>
            <div>
              <div className="brand-title">ChainScope</div>
              <div className="brand-sub">Yahoo Finance · Options</div>
            </div>
          </div>

          <div className="search-wrap">
            <div className="searchbox">
              <span className="search-icon">⌕</span>
              <input
                value={input}
                onChange={e=>setInput(e.target.value.toUpperCase())}
                onKeyDown={e=>{ if(e.key==='Enter') doSearch(input)}}
                placeholder="Ticker — e.g. AAPL"
                spellCheck={false}
                aria-label="Ticker symbol"
              />
              <button className="search-btn" onClick={()=>doSearch(input)} disabled={loading}>
                {loading ? 'Loading…' : 'Analyze'}
              </button>
            </div>
            <div className="examples">
              {EXAMPLE_TICKERS.map(t=>(
                <button key={t} className={`pill ${ticker===t?'pill-active':''}`} onClick={()=>{setInput(t); doSearch(t)}}>{t}</button>
              ))}
            </div>
          </div>

          <div className="topbar-right">
            <span className="live-dot" /> Live free data
          </div>
        </div>
      </header>

      <main className="main">
        {error && (
          <div className="alert error">
            <strong>Couldn’t load:</strong> {error}
            <div className="alert-hint">Powered by Python yfinance. Check ticker and ensure backend is running (<code>python -m backend.app</code> on :8000). Yahoo rate-limits — retry in a few seconds.</div>
          </div>
        )}

        {!ticker && !loading && !error && (
          <div className="placeholder">
            <h1>Option chain open interest &amp; volume</h1>
            <p>Search a ticker above. The app fetches expiries from Yahoo Finance, lets you pick an expiry, and plots open interest and volume by strike.</p>
          </div>
        )}

        {ticker && quote && (
          <>
            <section className="quote-row">
              <div className="quote-main">
                <div className="quote-sym">
                  <h1>{quote.symbol}</h1>
                  <span className="quote-name">{quote.longName || quote.shortName || ''}</span>
                </div>
                <div className="quote-price">
                  <span className="price">{quote.regularMarketPrice != null ? fmtPrice(quote.regularMarketPrice) : '—'} <em>{quote.currency || ''}</em></span>
                  <span className={`change ${priceChange>=0?'up':'down'}`}>{priceChange>=0?'▲':'▼'} {fmtPrice(Math.abs(priceChange))} ({(priceChangePct*100).toFixed(2)}%)</span>
                </div>
              </div>
              <div className="quote-meta">
                <div><label>Day range</label><span>{fmtPrice(quote.regularMarketDayLow)} — {fmtPrice(quote.regularMarketDayHigh)}</span></div>
                <div><label>52W range</label><span>{fmtPrice(quote.fiftyTwoWeekLow)} — {fmtPrice(quote.fiftyTwoWeekHigh)}</span></div>
                <div><label>Volume</label><span>{fmtNum(quote.regularMarketVolume)}</span></div>
              </div>
            </section>

            <section className="controls">
              <div className="control">
                <label>Expiry</label>
                <select
                  value={selected ?? ''}
                  onChange={e=> onExpiryChange(Number(e.target.value))}
                  disabled={expirations.length===0}
                >
                  {expirations.map(ts=>(
                    <option key={ts} value={ts}>{fmtExpiry(ts)}</option>
                  ))}
                </select>
                <span className="control-hint">{expirations.length} expiries</span>
              </div>

              <div className="control">
                <label>Strikes</label>
                <div className="seg">
                  <button className={strikeFilter==='near'?'on':''} onClick={()=>setStrikeFilter('near')}>Near spot (±15)</button>
                  <button className={strikeFilter==='all'?'on':''} onClick={()=>setStrikeFilter('all')}>All ({merged.length})</button>
                </div>
              </div>

              <div className="control">
                <label>Charts</label>
                <div className="seg">
                  <button className={viewMode==='both'?'on':''} onClick={()=>setViewMode('both')}>Both</button>
                  <button className={viewMode==='oi'?'on':''} onClick={()=>setViewMode('oi')}>OI only</button>
                  <button className={viewMode==='vol'?'on':''} onClick={()=>setViewMode('vol')}>Vol only</button>
                </div>
              </div>

              <div className="control grow">
                <label>Chart tip</label>
                <span className="muted">Spot price is the dashed line. Hover a bar for bid/ask and IV.</span>
              </div>
            </section>

            <section className="stats">
              <div className="stat"><label>Total call OI</label><strong>{fmtNum(totals.cOI)}</strong><span>{calls.length} contracts</span></div>
              <div className="stat"><label>Total put OI</label><strong>{fmtNum(totals.pOI)}</strong><span>{puts.length} contracts</span></div>
              <div className="stat"><label>Put / Call OI</label><strong>{totals.pcrOI.toFixed(2)}</strong><span>{totals.pcrOI>1?'Put-heavy':'Call-heavy'}</span></div>
              <div className="stat"><label>Total volume</label><strong>{fmtNum(totals.cV + totals.pV)}</strong><span>C {fmtNum(totals.cV)} · P {fmtNum(totals.pV)} · P/C {totals.pcrVol.toFixed(2)}</span></div>
              <div className="stat accent"><label>Max pain (est.)</label><strong>{totals.maxPain!=null ? totals.maxPain.toFixed(2) : '—'}</strong><span>strike with min option value</span></div>
            </section>

            <section className="charts">
              {(viewMode==='both' || viewMode==='oi') && (
                <div className="chart-card">
                  <div className="chart-head">
                    <h2>Open Interest by Strike</h2>
                    <span className="badge oi">OI</span>
                    <span className="chart-sub">{selected? shortExpiry(selected):''} · {filtered.length} strikes</span>
                  </div>
                  <div className="chart-wrap">
                    <ResponsiveContainer width="100%" height={340}>
                      <BarChart data={filtered} margin={{top:10, right:16, left:0, bottom:30}}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e6e8ee" vertical={false} />
                        <XAxis dataKey="strike" tick={{fontSize:11, fill:'#6b7280'}} tickLine={false} axisLine={{stroke:'#e6e8ee'}} angle={-28} textAnchor="end" height={50} interval="preserveStartEnd" />
                        <YAxis tick={{fontSize:11, fill:'#6b7280'}} tickLine={false} axisLine={false} tickFormatter={(v)=>fmtNum(v as number)} width={56}/>
                        <Tooltip
                          contentStyle={{borderRadius:8, border:'1px solid #e5e8f0', fontSize:12}}
                          formatter={(value: any, name: any) => [fmtNum(value as number), String(name ?? '')]}
                          labelFormatter={(l)=>`Strike ${l}`}
                        />
                        <Legend wrapperStyle={{fontSize:12}} />
                        {spot!=null && <ReferenceLine x={spot} stroke="#0f172a" strokeDasharray="6 4" label={{value:`Spot ${spot.toFixed(2)}`, position:'top', fontSize:11, fill:'#0f172a'}}/>}
                        <Bar dataKey="callOI" name="Call OI" fill="#0e9f6e" radius={[4,4,0,0]} maxBarSize={28} />
                        <Bar dataKey="putOI" name="Put OI" fill="#e05a33" radius={[4,4,0,0]} maxBarSize={28} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}
              {(viewMode==='both' || viewMode==='vol') && (
                <div className="chart-card">
                  <div className="chart-head">
                    <h2>Volume by Strike</h2>
                    <span className="badge vol">VOL</span>
                    <span className="chart-sub">Today’s traded contracts</span>
                  </div>
                  <div className="chart-wrap">
                    <ResponsiveContainer width="100%" height={340}>
                      <BarChart data={filtered} margin={{top:10, right:16, left:0, bottom:30}}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e6e8ee" vertical={false}/>
                        <XAxis dataKey="strike" tick={{fontSize:11, fill:'#6b7280'}} tickLine={false} axisLine={{stroke:'#e6e8ee'}} angle={-28} textAnchor="end" height={50} interval="preserveStartEnd"/>
                        <YAxis tick={{fontSize:11, fill:'#6b7280'}} tickLine={false} axisLine={false} tickFormatter={(v)=>fmtNum(v as number)} width={56}/>
                        <Tooltip contentStyle={{borderRadius:8, border:'1px solid #e5e8f0', fontSize:12}} formatter={(value:any,name:any)=>[fmtNum(value as number),String(name ?? '')]} labelFormatter={(l)=>`Strike ${l}`} />
                        <Legend wrapperStyle={{fontSize:12}}/>
                        {spot!=null && <ReferenceLine x={spot} stroke="#0f172a" strokeDasharray="6 4" />}
                        <Bar dataKey="callVol" name="Call Vol" fill="#0e7490" radius={[4,4,0,0]} maxBarSize={28}/>
                        <Bar dataKey="putVol" name="Put Vol" fill="#7c3aed" radius={[4,4,0,0]} maxBarSize={28}/>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}
            </section>

            <section className="ua-card">
              <div className="ua-head">
                <div className="ua-title-wrap">
                  <div className="ua-icon">⚡</div>
                  <div>
                    <h2>Unusual Activity — Volume &gt; Open Interest</h2>
                    <p className="ua-sub">
                      For expiry <strong>{selected ? new Date(selected*1000).toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric', timeZone:'UTC'}) : '—'}</strong> · When today&apos;s volume exceeds prior open interest, those contracts must be new positioning — not closing of old trades. 2×–10×+ confirms aggressive fresh flow.
                    </p>
                  </div>
                </div>
                <div className="ua-actions">
                  <div className="seg ua-seg">
                    <button className={uaThreshold==='all'?'on':''} onClick={()=>setUaThreshold('all')}>All ({unusual.length})</button>
                    <button className={uaThreshold==='2x'?'on':''} onClick={()=>setUaThreshold('2x')}>≥2× ({unusual.filter(r=>r.isInfinite||r.ratio>=2).length})</button>
                    <button className={uaThreshold==='5x'?'on':''} onClick={()=>setUaThreshold('5x')}>≥5× ({unusual.filter(r=>r.isInfinite||r.ratio>=5).length})</button>
                    <button className={uaThreshold==='10x'?'on':''} onClick={()=>setUaThreshold('10x')}>≥10× ({unusual.filter(r=>r.isInfinite||r.ratio>=10).length})</button>
                  </div>
                </div>
              </div>

              {uaStats && (
                <div className="ua-stats">
                  <div className="ua-stat">
                    <span className="ua-stat-label">Strikes flagged</span>
                    <strong className="ua-stat-value">{unusual.length}</strong>
                    <span className="ua-stat-hint">{uaStats.c} calls · {uaStats.p} puts</span>
                  </div>
                  <div className="ua-stat">
                    <span className="ua-stat-label">Highest Vol/OI</span>
                    <strong className="ua-stat-value">{uaStats.top.isInfinite ? '∞' : uaStats.top.ratio.toFixed(1)+'×'} <em>{uaStats.top.strike} {uaStats.top.side}</em></strong>
                    <span className="ua-stat-hint">{fmtNum(uaStats.top.volume)} vol / {fmtNum(uaStats.top.openInterest)} OI</span>
                  </div>
                  <div className="ua-stat">
                    <span className="ua-stat-label">Pure new interest</span>
                    <strong className="ua-stat-value">{uaStats.infCount}</strong>
                    <span className="ua-stat-hint">OI = 0 · all volume is new</span>
                  </div>
                  <div className="ua-stat">
                    <span className="ua-stat-label">Avg ratio</span>
                    <strong className="ua-stat-value">{uaStats.avgR ? uaStats.avgR.toFixed(1)+'×' : '—'}</strong>
                    <span className="ua-stat-hint">excl. ∞ cases</span>
                  </div>
                </div>
              )}

              <div className="ua-legend">
                <span className="ua-legend-item"><i className="dot tier0" /> 1–2× Active</span>
                <span className="ua-legend-item"><i className="dot tier1" /> 2–5× Unusual</span>
                <span className="ua-legend-item"><i className="dot tier2" /> 5–10× Highly Unusual</span>
                <span className="ua-legend-item"><i className="dot tier3" /> 10×+ / ∞ Extreme</span>
                <span className="ua-legend-note">Sorted by Vol/OI descending — highest conviction first</span>
              </div>

              {unusual.length === 0 ? (
                <div className="ua-empty">
                  <div className="ua-empty-icon">◯</div>
                  <h3>No unusual activity for this expiry</h3>
                  <p>No strike has volume exceeding open interest. This is typical on quiet sessions — more traded today would mean guaranteed new positioning. Try another expiry or a more active ticker like SPY, NVDA, or TSLA.</p>
                  <div className="ua-empty-detail">All {merged.length} strikes scanned · max Vol/OI &lt; 1×</div>
                </div>
              ) : filteredUnusual.length === 0 ? (
                <div className="ua-empty">
                  <div className="ua-empty-icon">◯</div>
                  <h3>No strikes at ≥{uaThreshold}</h3>
                  <p>Adjust the filter to see {unusual.length} flagged contracts at lower thresholds.</p>
                </div>
              ) : (
                <div className="ua-table-wrap">
                  <table className="ua-table">
                    <thead>
                      <tr>
                        <th>Strike</th>
                        <th>Side</th>
                        <th style={{textAlign:'right'}}>Volume</th>
                        <th style={{textAlign:'right'}}>Open Int.</th>
                        <th style={{textAlign:'right'}}>Vol / OI</th>
                        <th>Signal</th>
                        <th style={{textAlign:'right'}}>Last</th>
                        <th style={{textAlign:'right'}}>IV</th>
                        <th style={{textAlign:'right'}}>Bid / Ask</th>
                        <th style={{textAlign:'right'}}>Vol bar</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredUnusual.map((r,i)=>{
                        const sig = signalFor(r)
                        const pct = r.isInfinite ? 100 : Math.min(100, (Math.log10(r.ratio+1)/Math.log10(11))*100)
                        return (
                          <tr key={`${r.strike}-${r.side}-${i}`} className={`tier-${sig.tier}`}>
                            <td className="ua-strike">{r.strike.toFixed(2)} {spot!=null && Math.abs(r.strike-spot)<0.5 ? <span className="spot-mark" title="Near spot">• ATM</span> : null}</td>
                            <td><span className={`side-pill ${r.side==='Call'?'call':'put'}`}>{r.side}</span></td>
                            <td style={{textAlign:'right', fontWeight:700}}>{fmtNum(r.volume)}</td>
                            <td style={{textAlign:'right', color:'var(--muted)'}}>{fmtNum(r.openInterest)}</td>
                            <td style={{textAlign:'right'}}>
                              <span className={`ratio tier-${sig.tier}`}>{r.isInfinite ? '∞' : r.ratio.toFixed(2)+'×'}</span>
                              {r.isInfinite && <span className="inf-note">new</span>}
                            </td>
                            <td>
                              <span className={`signal-badge tier-${sig.tier}`}>{sig.label}</span>
                              <span className="signal-detail">{sig.detail}</span>
                            </td>
                            <td style={{textAlign:'right'}}>{fmtPrice(r.contract.lastPrice)}</td>
                            <td style={{textAlign:'right'}}>{r.contract.impliedVolatility!=null ? (r.contract.impliedVolatility*100).toFixed(1)+'%' : '—'}</td>
                            <td style={{textAlign:'right'}} className="mono small">{r.contract.bid!=null || r.contract.ask!=null ? `${fmtPrice(r.contract.bid)} / ${fmtPrice(r.contract.ask)}` : '—'}</td>
                            <td style={{textAlign:'right', minWidth:90}}>
                              <div className="ratio-bar"><div className={`ratio-fill tier-${sig.tier}`} style={{width: `${pct}%`}} /></div>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="ua-foot">
                <span><strong>Why it matters:</strong> OI is yesterday&apos;s outstanding contracts. If today Vol &gt; OI, at least <em>Vol − OI</em> contracts traded today must be new opens — the prior position wasn&apos;t large enough to close them. At 2–10×+, the strike is being actively repositioned right now.</span>
                <span className="ua-foot-count">{filteredUnusual.length} shown · {unusual.length} flagged total · {merged.length*2} contracts scanned</span>
              </div>
            </section>

            <section className="table-card">
              <div className="table-head">
                <h2>Chain — {selected ? new Date(selected*1000).toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric', timeZone:'UTC'}) : ''}</h2>
                <span className="muted">{filtered.length} strikes shown · scroll horizontally</span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th colSpan={5} className="th-group calls">Calls</th>
                      <th className="th-strike">Strike</th>
                      <th colSpan={5} className="th-group puts">Puts</th>
                    </tr>
                    <tr className="th-sub">
                      <th>OI</th><th>Vol</th><th>Last</th><th>Bid/Ask</th><th>IV</th>
                      <th></th>
                      <th>IV</th><th>Bid/Ask</th><th>Last</th><th>Vol</th><th>OI</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map(r=>{
                      const callITM = spot!=null && r.call ? spot > r.strike : false
                      const putITM = spot!=null && r.put ? spot < r.strike : false
                      return (
                        <tr key={r.strike} className={spot!=null && Math.abs(r.strike-spot)<0.01 ? 'row-spot' : ''}>
                          <td className={callITM?'itm':''}>{fmtNum(r.callOI)}</td>
                          <td>{fmtNum(r.callVol)}</td>
                          <td>{r.call? fmtPrice(r.call.lastPrice):'—'}</td>
                          <td className="mono">{r.call? `${fmtPrice(r.call.bid)} / ${fmtPrice(r.call.ask)}`:'—'}</td>
                          <td>{r.call?.impliedVolatility!=null ? (r.call.impliedVolatility*100).toFixed(1)+'%':'—'}</td>
                          <td className="strike-cell">{r.strike.toFixed(2)}{spot!=null && Math.abs(r.strike-spot)<0.5 ? ' •':''}</td>
                          <td>{r.put?.impliedVolatility!=null ? (r.put.impliedVolatility*100).toFixed(1)+'%':'—'}</td>
                          <td className="mono">{r.put? `${fmtPrice(r.put.bid)} / ${fmtPrice(r.put.ask)}`:'—'}</td>
                          <td>{r.put? fmtPrice(r.put.lastPrice):'—'}</td>
                          <td>{fmtNum(r.putVol)}</td>
                          <td className={putITM?'itm':''}>{fmtNum(r.putOI)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              <div className="table-foot muted">ITM rows are highlighted. Max pain ≈ {totals.maxPain?.toFixed(2) ?? '—'} · Data from Yahoo Finance (free, 15-min delayed).</div>
            </section>
          </>
        )}

        {loading && <div className="loading">Fetching option chain… <span className="spinner" /></div>}

        <footer className="foot">
          <span>Data: Yahoo Finance via Python yfinance — no API key required. Backend: FastAPI + yfinance.</span>
          <span>Built for analysis, not advice. Quotes are delayed.</span>
        </footer>
      </main>
    </div>
  )
}
