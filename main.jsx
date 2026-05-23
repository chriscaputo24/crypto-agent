import { useState, useEffect, useRef, useCallback } from "react";

const INITIAL_CASH = 10000;
const COINS = ["BTC", "ETH", "SOL", "BNB", "XRP"];

const SEED_PRICES = { BTC: 103000, ETH: 2500, SOL: 172, BNB: 650, XRP: 2.30 };
const VOLATILITY  = { BTC: 0.018, ETH: 0.022, SOL: 0.030, BNB: 0.020, XRP: 0.028 };

const COLORS = {
  bg: "#050a0e",
  panel: "#0a1520",
  border: "#0f2535",
  green: "#00ff88",
  red: "#ff3b5c",
  amber: "#ffb800",
  blue: "#00aaff",
  dim: "#1a3347",
  text: "#c8dde8",
  muted: "#4a7a94",
};

function formatUSD(n) {
  if (n === undefined || n === null || isNaN(n)) return "$0.00";
  return "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function formatCrypto(n, decimals = 6) {
  return Number(n).toFixed(decimals);
}
function pct(a, b) {
  if (!b) return 0;
  return ((a - b) / b) * 100;
}

// Box-Muller normal sample
function randn() {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Compute RSI-lite (14 periods or fewer)
function computeRSI(history) {
  if (history.length < 3) return 50;
  const window = history.slice(-14);
  let gains = 0, losses = 0;
  for (let i = 1; i < window.length; i++) {
    const change = window[i] - window[i - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

// Simple moving average
function sma(history, n) {
  const slice = history.slice(-n);
  if (slice.length === 0) return 0;
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

// ── Terminal log line ──────────────────────────────────────────────────────────
function LogLine({ entry }) {
  const color =
    entry.type === "buy" ? COLORS.green :
    entry.type === "sell" ? COLORS.red :
    entry.type === "hold" ? COLORS.amber :
    entry.type === "error" ? COLORS.red :
    entry.type === "info" ? COLORS.blue :
    COLORS.muted;

  return (
    <div style={{ display: "flex", gap: 10, padding: "4px 0", borderBottom: `1px solid ${COLORS.dim}`, fontSize: 12 }}>
      <span style={{ color: COLORS.muted, whiteSpace: "nowrap", fontFamily: "monospace" }}>
        {new Date(entry.ts).toLocaleTimeString()}
      </span>
      <span style={{ color, fontFamily: "monospace", fontWeight: entry.type !== "log" ? 700 : 400 }}>
        [{entry.type?.toUpperCase()}]
      </span>
      <span style={{ color: COLORS.text, fontFamily: "monospace", flex: 1 }}>{entry.msg}</span>
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────
export default function CryptoAgent() {
  const [portfolio, setPortfolio] = useState({
    cash: INITIAL_CASH,
    holdings: {},
    trades: [],
  });
  const [prices, setPrices] = useState({});
  const [priceHistory, setPriceHistory] = useState(() => {
    const init = {};
    COINS.forEach(c => init[c] = []);
    return init;
  });
  const [logs, setLogs] = useState([]);
  const [latestReasoning, setLatestReasoning] = useState(null);
  const [running, setRunning] = useState(false);
  const [cycleCount, setCycleCount] = useState(0);
  const [status, setStatus] = useState("idle");
  const [priceSource, setPriceSource] = useState("live"); // "live" | "sim"
  const [activeProvider, setActiveProvider] = useState(null);
  const priceSourceRef = useRef("live");
  const activeProviderRef = useRef(null);
  const logsEndRef = useRef(null);
  const stopRef = useRef(false);
  const intervalRef = useRef(null);
  const portfolioRef = useRef(portfolio);
  const pricesRef = useRef(prices);
  const historyRef = useRef(priceHistory);

  useEffect(() => { priceSourceRef.current = priceSource; }, [priceSource]);

  useEffect(() => { portfolioRef.current = portfolio; }, [portfolio]);
  useEffect(() => { pricesRef.current = prices; }, [prices]);
  useEffect(() => { historyRef.current = priceHistory; }, [priceHistory]);

  const addLog = useCallback((msg, type = "log") => {
    setLogs(prev => [...prev.slice(-200), { msg, type, ts: Date.now() }]);
  }, []);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  // ── Multi-source live price providers (try in order) ─────────────────────────
  const PROVIDERS = [
    {
      name: "Binance",
      fetch: async () => {
        const map = { BTC: "BTCUSDT", ETH: "ETHUSDT", SOL: "SOLUSDT", BNB: "BNBUSDT", XRP: "XRPUSDT" };
        const url = `https://api.binance.com/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(Object.values(map)))}`;
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const arr = await r.json();
        const lookup = {};
        arr.forEach(i => { lookup[i.symbol] = parseFloat(i.price); });
        const out = {};
        for (const c of COINS) {
          if (!lookup[map[c]]) throw new Error(`missing ${c}`);
          out[c] = lookup[map[c]];
        }
        return out;
      },
    },
    {
      name: "Coinbase",
      fetch: async () => {
        const map = { BTC: "BTC-USD", ETH: "ETH-USD", SOL: "SOL-USD", BNB: "BNB-USD", XRP: "XRP-USD" };
        const results = await Promise.all(
          COINS.map(c => fetch(`https://api.coinbase.com/v2/prices/${map[c]}/spot`).then(r => {
            if (!r.ok) throw new Error(`${c} HTTP ${r.status}`);
            return r.json();
          }))
        );
        const out = {};
        COINS.forEach((c, i) => {
          const px = parseFloat(results[i]?.data?.amount);
          if (!px) throw new Error(`bad ${c}`);
          out[c] = px;
        });
        return out;
      },
    },
    {
      name: "CryptoCompare",
      fetch: async () => {
        const url = "https://min-api.cryptocompare.com/data/pricemulti?fsyms=BTC,ETH,SOL,BNB,XRP&tsyms=USD";
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        const out = {};
        for (const c of COINS) {
          if (!data[c]?.USD) throw new Error(`missing ${c}`);
          out[c] = data[c].USD;
        }
        return out;
      },
    },
    {
      name: "CoinCap",
      fetch: async () => {
        const map = { BTC: "bitcoin", ETH: "ethereum", SOL: "solana", BNB: "binance-coin", XRP: "xrp" };
        const url = `https://api.coincap.io/v2/assets?ids=${Object.values(map).join(",")}`;
        const r = await fetch(url);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const { data } = await r.json();
        const lookup = {};
        data.forEach(d => { lookup[d.id] = parseFloat(d.priceUsd); });
        const out = {};
        for (const c of COINS) {
          if (!lookup[map[c]]) throw new Error(`missing ${c}`);
          out[c] = lookup[map[c]];
        }
        return out;
      },
    },
    {
      name: "Kraken",
      fetch: async () => {
        const map = { BTC: "XXBTZUSD", ETH: "XETHZUSD", SOL: "SOLUSD", BNB: null, XRP: "XXRPZUSD" };
        const pairs = Object.values(map).filter(Boolean).join(",");
        const r = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${pairs}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const { result, error } = await r.json();
        if (error?.length) throw new Error(error.join(","));
        const out = {};
        for (const c of COINS) {
          if (c === "BNB") { out[c] = pricesRef.current[c] || SEED_PRICES[c]; continue; }
          const k = map[c];
          const px = result?.[k]?.c?.[0];
          if (!px) throw new Error(`missing ${c}`);
          out[c] = parseFloat(px);
        }
        return out;
      },
    },
  ];

  async function fetchRealPrices() {
    const errors = [];
    for (const p of PROVIDERS) {
      try {
        const prices = await p.fetch();
        if (activeProviderRef.current !== p.name) {
          addLog(`Connected to ${p.name} ✓`, "info");
          activeProviderRef.current = p.name;
          setActiveProvider(p.name);
        }
        return prices;
      } catch (e) {
        errors.push(`${p.name}: ${e.message}`);
      }
    }
    throw new Error(`All providers failed — ${errors.join(" | ")}`);
  }

  function simulatePrices() {
    const base = Object.keys(pricesRef.current).length ? pricesRef.current : SEED_PRICES;
    const newPrices = {};
    for (const coin of COINS) {
      const sigma = VOLATILITY[coin];
      const drift = (Math.random() - 0.48) * 0.004;
      const shock = sigma * randn();
      newPrices[coin] = Math.max(base[coin] * (1 + drift + shock), 0.0001);
    }
    return newPrices;
  }

  async function generatePrices() {
    if (priceSourceRef.current === "live") {
      try {
        return await fetchRealPrices();
      } catch (e) {
        addLog(`All live sources failed (${e.message.slice(0, 100)}…) — using simulation`, "error");
        priceSourceRef.current = "sim";
        setPriceSource("sim");
        setActiveProvider(null);
        activeProviderRef.current = null;
        return simulatePrices();
      }
    }
    return simulatePrices();
  }

  // ── Rule-based trading agent ─────────────────────────────────────────────────
  function decideActions(currentPortfolio, currentPrices, currentHistory) {
    const actions = [];
    const analyses = [];

    // Compute total value for sizing
    const holdingsValue = Object.entries(currentPortfolio.holdings)
      .reduce((s, [c, h]) => s + h.qty * (currentPrices[c] || h.avgCost), 0);
    const totalValue = currentPortfolio.cash + holdingsValue;
    const maxTradeUSD = totalValue * 0.25;
    const minCash = 200;

    for (const coin of COINS) {
      const price = currentPrices[coin];
      const history = currentHistory[coin] || [];
      if (!price || history.length < 4) {
        analyses.push({ coin, signal: "WAIT", reason: "Insufficient history" });
        continue;
      }

      const rsi = computeRSI(history);
      const ma5 = sma(history, 5);
      const ma15 = sma(history, 15);
      const momentum = history.length >= 5
        ? ((price - history[history.length - 5]) / history[history.length - 5]) * 100
        : 0;
      const holding = currentPortfolio.holdings[coin];
      const pnlPct = holding ? pct(price, holding.avgCost) : null;

      let signal = "HOLD";
      let reason = "";
      let weight = 0;

      // ── SELL logic (only if we hold) ──
      if (holding) {
        if (pnlPct >= 8) {
          signal = "SELL"; weight = 3;
          reason = `Take profit +${pnlPct.toFixed(2)}% (target hit)`;
        } else if (pnlPct <= -12) {
          signal = "SELL"; weight = 3;
          reason = `Stop loss ${pnlPct.toFixed(2)}% (cutting loss)`;
        } else if (rsi > 75 && pnlPct > 3) {
          signal = "SELL"; weight = 2;
          reason = `Overbought RSI=${rsi.toFixed(0)} & in profit ${pnlPct.toFixed(2)}%`;
        } else if (ma5 < ma15 && momentum < -2 && pnlPct > 0) {
          signal = "SELL"; weight = 1;
          reason = `Trend reversal (MA5<MA15, momentum ${momentum.toFixed(2)}%) lock in gains`;
        } else {
          reason = `Hold position (P&L ${pnlPct.toFixed(2)}%, RSI ${rsi.toFixed(0)})`;
        }
      }
      // ── BUY logic (only if we don't hold) ──
      else {
        if (rsi < 30 && momentum < -3) {
          signal = "BUY"; weight = 3;
          reason = `Oversold RSI=${rsi.toFixed(0)}, momentum ${momentum.toFixed(2)}% — mean reversion`;
        } else if (ma5 > ma15 && momentum > 2 && rsi < 65) {
          signal = "BUY"; weight = 2;
          reason = `Bullish crossover (MA5>MA15, momentum +${momentum.toFixed(2)}%, RSI ${rsi.toFixed(0)})`;
        } else if (rsi < 40 && ma5 > ma15) {
          signal = "BUY"; weight = 1;
          reason = `Modest entry — RSI ${rsi.toFixed(0)}, uptrend forming`;
        } else {
          reason = `No setup (RSI ${rsi.toFixed(0)}, momentum ${momentum.toFixed(2)}%)`;
        }
      }

      analyses.push({ coin, signal, reason, rsi, ma5, ma15, momentum, price, pnlPct });

      if (signal === "BUY" && weight > 0) {
        const sizeFraction = 0.10 + weight * 0.05; // 15-25% of portfolio
        const usd = Math.min(maxTradeUSD, totalValue * sizeFraction);
        actions.push({ action: "buy", coin, usd_amount: usd, reason });
      } else if (signal === "SELL") {
        actions.push({ action: "sell", coin, reason });
      }
    }

    return { actions, analyses, totalValue };
  }

  // ── Execute one trading cycle ────────────────────────────────────────────────
  async function runCycle() {
    setStatus("fetching");

    // 1. Get prices (live or simulated)
    const newPrices = await generatePrices();
    setPrices(newPrices);
    pricesRef.current = newPrices;

    // 2. Update price history
    const updatedHistory = { ...historyRef.current };
    for (const coin of COINS) {
      updatedHistory[coin] = [...(updatedHistory[coin] || []), newPrices[coin]].slice(-50);
    }
    setPriceHistory(updatedHistory);
    historyRef.current = updatedHistory;

    addLog(`[${priceSourceRef.current === "live" ? "LIVE" : "SIM"}] BTC ${formatUSD(newPrices.BTC)} · ETH ${formatUSD(newPrices.ETH)} · SOL ${formatUSD(newPrices.SOL)} · BNB ${formatUSD(newPrices.BNB)} · XRP ${formatUSD(newPrices.XRP)}`, "info");

    // 3. Analyse and decide
    setStatus("thinking");
    const { actions, analyses, totalValue } = decideActions(portfolioRef.current, newPrices, updatedHistory);
    setLatestReasoning({ analyses, totalValue, actions: actions.length });

    // 4. Execute trades
    setStatus("trading");
    let updatedPortfolio = {
      cash: portfolioRef.current.cash,
      holdings: { ...portfolioRef.current.holdings },
      trades: [...portfolioRef.current.trades],
    };

    if (actions.length === 0) {
      addLog("Agent: HOLD all positions — no setups detected", "hold");
    }

    for (const action of actions) {
      const coin = action.coin;
      const price = newPrices[coin];

      if (action.action === "buy") {
        const usdAmount = Math.min(action.usd_amount, updatedPortfolio.cash - 200);
        if (usdAmount < 50) {
          addLog(`Skip BUY ${coin}: insufficient cash (${formatUSD(updatedPortfolio.cash)})`, "error");
          continue;
        }
        const qty = usdAmount / price;
        const existing = updatedPortfolio.holdings[coin] || { qty: 0, avgCost: 0 };
        const newQty = existing.qty + qty;
        const newAvg = (existing.qty * existing.avgCost + qty * price) / newQty;
        updatedPortfolio.cash -= usdAmount;
        updatedPortfolio.holdings[coin] = { qty: newQty, avgCost: newAvg };
        updatedPortfolio.trades.push({ action: "buy", coin, qty, price, usd: usdAmount, ts: Date.now() });
        addLog(`BUY ${coin} ${formatUSD(usdAmount)} @ ${formatUSD(price)} — ${action.reason}`, "buy");

      } else if (action.action === "sell") {
        const holding = updatedPortfolio.holdings[coin];
        if (!holding || holding.qty <= 0) continue;
        const proceeds = holding.qty * price;
        const pnl = proceeds - holding.qty * holding.avgCost;
        updatedPortfolio.cash += proceeds;
        delete updatedPortfolio.holdings[coin];
        updatedPortfolio.trades.push({ action: "sell", coin, qty: holding.qty, price, usd: proceeds, pnl, ts: Date.now() });
        addLog(`SELL ${coin} ${formatUSD(proceeds)} @ ${formatUSD(price)} — P&L ${pnl >= 0 ? "+" : ""}${formatUSD(pnl)} — ${action.reason}`, "sell");
      }
    }

    setPortfolio(updatedPortfolio);
    portfolioRef.current = updatedPortfolio;
    setCycleCount(c => c + 1);
    setStatus("idle");
  }

  // ── Start / Stop ──────────────────────────────────────────────────────────────
  async function startAgent() {
    stopRef.current = false;
    setRunning(true);
    addLog(`═══ AUTONOMOUS AGENT ONLINE (${priceSourceRef.current === "live" ? "LIVE PRICES" : "SIMULATED"}) ═══`, "info");
    await runCycle();
    const cycleMs = priceSourceRef.current === "live" ? 10000 : 4000;
    intervalRef.current = setInterval(async () => {
      if (stopRef.current) {
        clearInterval(intervalRef.current);
        return;
      }
      await runCycle();
    }, cycleMs);
  }

  function stopAgent() {
    stopRef.current = true;
    clearInterval(intervalRef.current);
    setRunning(false);
    setStatus("idle");
    addLog("═══ AGENT OFFLINE ═══", "info");
  }

  function resetPortfolio() {
    stopAgent();
    setPortfolio({ cash: INITIAL_CASH, holdings: {}, trades: [] });
    setPrices({});
    const init = {};
    COINS.forEach(c => init[c] = []);
    setPriceHistory(init);
    setLogs([]);
    setLatestReasoning(null);
    setCycleCount(0);
    addLog("Portfolio reset to " + formatUSD(INITIAL_CASH), "info");
  }

  // ── Derived stats ─────────────────────────────────────────────────────────────
  const totalHoldingsValue = Object.entries(portfolio.holdings)
    .reduce((sum, [coin, h]) => sum + h.qty * (prices[coin] || h.avgCost), 0);
  const totalValue = portfolio.cash + totalHoldingsValue;
  const totalPnL = totalValue - INITIAL_CASH;
  const totalPnLPct = pct(totalValue, INITIAL_CASH);
  const realizedPnL = portfolio.trades
    .filter(t => t.action === "sell" && t.pnl !== undefined)
    .reduce((s, t) => s + t.pnl, 0);

  const statusLabel = {
    idle: "● IDLE",
    fetching: "⟳ TICK",
    thinking: "◆ ANALYZING",
    trading: "▶ EXECUTING",
  }[status];

  const statusColor = {
    idle: COLORS.muted,
    fetching: COLORS.blue,
    thinking: COLORS.amber,
    trading: COLORS.green,
  }[status];

  return (
    <div style={{
      background: COLORS.bg,
      minHeight: "100vh",
      fontFamily: "'Courier New', monospace",
      color: COLORS.text,
    }}>
      {/* Header */}
      <div style={{
        background: COLORS.panel,
        borderBottom: `2px solid ${COLORS.green}`,
        padding: "12px 20px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
      }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, color: COLORS.green, letterSpacing: 3 }}>
            ▲ AUTONOMOUS CRYPTO AGENT
          </div>
          <div style={{ fontSize: 11, color: COLORS.muted, marginTop: 2 }}>
            RULE-BASED QUANT · RSI · MOMENTUM · MA-CROSSOVER · 10s CYCLES
          </div>
        </div>
        <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
          <button
            onClick={() => !running && setPriceSource(priceSource === "live" ? "sim" : "live")}
            disabled={running}
            style={{
              background: priceSource === "live" ? COLORS.green : COLORS.amber,
              color: "#000",
              border: "none",
              borderRadius: 4,
              padding: "4px 10px",
              fontFamily: "monospace",
              fontSize: 11,
              fontWeight: 700,
              cursor: running ? "not-allowed" : "pointer",
              letterSpacing: 1,
              opacity: running ? 0.6 : 1,
            }}
            title={running ? "Stop agent to switch" : "Toggle price source"}
          >
            {priceSource === "live" ? `● LIVE${activeProvider ? ` (${activeProvider.toUpperCase()})` : ""}` : "◆ SIMULATED"}
          </button>
          <div style={{ fontSize: 12, color: statusColor, fontWeight: 700 }}>{statusLabel}</div>
          <div style={{ fontSize: 11, color: COLORS.muted }}>CYCLE #{cycleCount}</div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", height: "calc(100vh - 80px)" }}>

        {/* Left sidebar */}
        <div style={{ borderRight: `1px solid ${COLORS.border}`, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ padding: 16, borderBottom: `1px solid ${COLORS.border}` }}>
            <div style={{ fontSize: 11, color: COLORS.muted, marginBottom: 8, letterSpacing: 2 }}>PORTFOLIO VALUE</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: COLORS.green }}>{formatUSD(totalValue)}</div>
            <div style={{ fontSize: 13, color: totalPnL >= 0 ? COLORS.green : COLORS.red, marginTop: 4 }}>
              {totalPnL >= 0 ? "▲" : "▼"} {formatUSD(Math.abs(totalPnL))} ({totalPnLPct >= 0 ? "+" : ""}{totalPnLPct.toFixed(2)}%)
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1, background: COLORS.border }}>
            {[
              ["CASH", formatUSD(portfolio.cash)],
              ["HOLDINGS", formatUSD(totalHoldingsValue)],
              ["REALIZED P&L", formatUSD(realizedPnL), realizedPnL >= 0 ? COLORS.green : COLORS.red],
              ["TRADES", portfolio.trades.length],
            ].map(([label, val, color]) => (
              <div key={label} style={{ background: COLORS.panel, padding: "10px 12px" }}>
                <div style={{ fontSize: 10, color: COLORS.muted, letterSpacing: 1 }}>{label}</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: color || COLORS.text, marginTop: 2 }}>{val}</div>
              </div>
            ))}
          </div>

          <div style={{ padding: 12, flex: 1, overflowY: "auto" }}>
            <div style={{ fontSize: 11, color: COLORS.muted, letterSpacing: 2, marginBottom: 10 }}>HOLDINGS</div>
            {Object.keys(portfolio.holdings).length === 0 ? (
              <div style={{ color: COLORS.muted, fontSize: 12 }}>No open positions</div>
            ) : Object.entries(portfolio.holdings).map(([coin, h]) => {
              const cur = prices[coin] || h.avgCost;
              const p = pct(cur, h.avgCost);
              return (
                <div key={coin} style={{ background: COLORS.dim, borderRadius: 4, padding: "8px 10px", marginBottom: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: COLORS.amber, fontWeight: 700 }}>{coin}</span>
                    <span style={{ color: p >= 0 ? COLORS.green : COLORS.red, fontSize: 12 }}>
                      {p >= 0 ? "+" : ""}{p.toFixed(2)}%
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: COLORS.muted, marginTop: 3 }}>
                    {formatCrypto(h.qty)} @ avg {formatUSD(h.avgCost)}
                  </div>
                  <div style={{ fontSize: 12, color: COLORS.text, marginTop: 2 }}>
                    Value: {formatUSD(h.qty * cur)}
                  </div>
                </div>
              );
            })}

            <div style={{ fontSize: 11, color: COLORS.muted, letterSpacing: 2, margin: "12px 0 8px" }}>LIVE PRICES</div>
            {COINS.map(coin => (
              <div key={coin} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", borderBottom: `1px solid ${COLORS.dim}`, fontSize: 12 }}>
                <span style={{ color: COLORS.blue }}>{coin}</span>
                <span>{prices[coin] ? formatUSD(prices[coin]) : "—"}</span>
              </div>
            ))}
          </div>

          <div style={{ padding: 12, borderTop: `1px solid ${COLORS.border}`, display: "flex", flexDirection: "column", gap: 8 }}>
            <button
              onClick={running ? stopAgent : startAgent}
              style={{
                background: running ? COLORS.red : COLORS.green,
                color: "#000",
                border: "none",
                borderRadius: 4,
                padding: "10px 0",
                fontFamily: "monospace",
                fontWeight: 700,
                fontSize: 13,
                cursor: "pointer",
                letterSpacing: 2,
              }}
            >
              {running ? "■ STOP AGENT" : "▶ START AGENT"}
            </button>
            <button
              onClick={() => !running && runCycle()}
              disabled={running}
              style={{
                background: "transparent",
                color: COLORS.amber,
                border: `1px solid ${COLORS.amber}`,
                borderRadius: 4,
                padding: "8px 0",
                fontFamily: "monospace",
                fontSize: 12,
                cursor: running ? "not-allowed" : "pointer",
                opacity: running ? 0.4 : 1,
              }}
            >
              ⟳ MANUAL CYCLE
            </button>
            <button
              onClick={resetPortfolio}
              style={{
                background: "transparent",
                color: COLORS.muted,
                border: `1px solid ${COLORS.dim}`,
                borderRadius: 4,
                padding: "8px 0",
                fontFamily: "monospace",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              ↺ RESET
            </button>
          </div>
        </div>

        {/* Right panel */}
        <div style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
          {/* Agent analysis */}
          <div style={{ padding: "12px 16px", borderBottom: `1px solid ${COLORS.border}`, maxHeight: "40%", overflowY: "auto" }}>
            <div style={{ fontSize: 11, color: COLORS.muted, letterSpacing: 2, marginBottom: 8 }}>
              AGENT ANALYSIS {latestReasoning && `· ${latestReasoning.actions} action(s)`}
            </div>
            {!latestReasoning ? (
              <div style={{ color: COLORS.muted, fontSize: 12 }}>Start the agent to see decision logic...</div>
            ) : (
              <div style={{ display: "grid", gap: 6 }}>
                {latestReasoning.analyses.map(a => (
                  <div key={a.coin} style={{
                    background: "#07121b",
                    border: `1px solid ${a.signal === "BUY" ? COLORS.green : a.signal === "SELL" ? COLORS.red : COLORS.dim}`,
                    borderLeft: `3px solid ${a.signal === "BUY" ? COLORS.green : a.signal === "SELL" ? COLORS.red : a.signal === "HOLD" ? COLORS.amber : COLORS.muted}`,
                    borderRadius: 4,
                    padding: "8px 12px",
                    fontSize: 12,
                  }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                      <span>
                        <span style={{ color: COLORS.amber, fontWeight: 700 }}>{a.coin}</span>
                        <span style={{
                          marginLeft: 10,
                          color: a.signal === "BUY" ? COLORS.green : a.signal === "SELL" ? COLORS.red : COLORS.amber,
                          fontWeight: 700,
                        }}>{a.signal}</span>
                      </span>
                      {a.rsi !== undefined && (
                        <span style={{ color: COLORS.muted, fontSize: 11 }}>
                          RSI {a.rsi.toFixed(0)} · Mom {a.momentum >= 0 ? "+" : ""}{a.momentum.toFixed(2)}%
                          {a.pnlPct !== null && a.pnlPct !== undefined && (
                            <span style={{ color: a.pnlPct >= 0 ? COLORS.green : COLORS.red, marginLeft: 8 }}>
                              · P&L {a.pnlPct >= 0 ? "+" : ""}{a.pnlPct.toFixed(2)}%
                            </span>
                          )}
                        </span>
                      )}
                    </div>
                    <div style={{ color: COLORS.text, fontSize: 11 }}>{a.reason}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Trade history */}
          <div style={{ padding: "12px 16px", borderBottom: `1px solid ${COLORS.border}`, maxHeight: "25%", overflowY: "auto" }}>
            <div style={{ fontSize: 11, color: COLORS.muted, letterSpacing: 2, marginBottom: 6 }}>TRADE HISTORY</div>
            {portfolio.trades.length === 0
              ? <div style={{ color: COLORS.muted, fontSize: 12 }}>No trades yet</div>
              : [...portfolio.trades].reverse().slice(0, 30).map((t, i) => (
                <div key={i} style={{ display: "flex", gap: 10, fontSize: 12, padding: "3px 0", borderBottom: `1px solid ${COLORS.dim}` }}>
                  <span style={{ color: COLORS.muted }}>{new Date(t.ts).toLocaleTimeString()}</span>
                  <span style={{ color: t.action === "buy" ? COLORS.green : COLORS.red, fontWeight: 700, width: 36 }}>{t.action.toUpperCase()}</span>
                  <span style={{ color: COLORS.amber, width: 32 }}>{t.coin}</span>
                  <span style={{ color: COLORS.text }}>{formatUSD(t.usd)}</span>
                  <span style={{ color: COLORS.muted }}>@ {formatUSD(t.price)}</span>
                  {t.pnl !== undefined && (
                    <span style={{ color: t.pnl >= 0 ? COLORS.green : COLORS.red }}>
                      {t.pnl >= 0 ? "+" : ""}{formatUSD(t.pnl)}
                    </span>
                  )}
                </div>
              ))
            }
          </div>

          {/* Activity log */}
          <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px" }}>
            <div style={{ fontSize: 11, color: COLORS.muted, letterSpacing: 2, marginBottom: 6 }}>ACTIVITY LOG</div>
            {logs.length === 0
              ? <div style={{ color: COLORS.muted, fontSize: 12 }}>Press START AGENT to begin.</div>
              : logs.map((entry, i) => <LogLine key={i} entry={entry} />)
            }
            <div ref={logsEndRef} />
          </div>
        </div>
      </div>

      <div style={{
        background: "#0a0a0a",
        borderTop: `1px solid ${COLORS.dim}`,
        padding: "4px 16px",
        fontSize: 10,
        color: COLORS.muted,
        textAlign: "center",
      }}>
        ⚠ PAPER TRADING · {priceSource === "live" ? "LIVE BINANCE PRICES" : "SIMULATED PRICES"} · NOT FINANCIAL ADVICE · EDUCATIONAL USE ONLY
      </div>
    </div>
  );
}
