# Autonomous Crypto Trading Agent

Rule-based paper-trading bot using RSI, momentum, and MA-crossover signals.
Pulls live prices from Binance → Coinbase → CryptoCompare → CoinCap → Kraken (in cascade).

## Run on StackBlitz (easiest, ~2 minutes)

1. Go to **https://stackblitz.com**
2. Click **Create new project** → choose **Vite + React** (JavaScript)
3. In the file tree on the left, replace these files with the ones from this folder:
   - `package.json`
   - `vite.config.js`
   - `index.html`
   - `src/main.jsx`
   - `src/App.jsx` → rename to `src/CryptoAgent.jsx` (or just paste content into App.jsx and update main.jsx import)
4. StackBlitz auto-installs dependencies and runs `npm run dev`
5. Click **START AGENT** in the preview pane

## Run locally with Vite

```bash
cd crypto-agent-stackblitz
npm install
npm run dev
# open http://localhost:5173
```

## Notes

- All trades are **paper trades** with $10,000 starting balance — no real money involved
- Price source defaults to LIVE; falls back to simulated Brownian motion only if every exchange API fails
- 10-second cycles in live mode, 4-second cycles in simulation mode
- Click the green LIVE / amber SIMULATED badge in the header to toggle (while stopped)

## Not financial advice. Educational use only.
