// Real-time stop-monitoring worker.
//
// What this does, in plain terms:
//   - Connects to Finnhub's free real-time WebSocket feed (genuinely live
//     ticks, not a 5-minute poll).
//   - Every SYNC_INTERVAL_MS, asks Base44 which positions are currently
//     open and what their current_stop is, and subscribes to those symbols.
//   - On every live tick, checks: has price crossed that position's stop?
//   - The instant it has, calls a Base44 function to close that position
//     immediately, using the real tick price — not waiting for the next
//     scheduled scan.
//
// This is deliberately a SEPARATE, small process from the main Base44 app.
// It only ever does two things: watch prices, and fire an urgent close.
// It never opens new positions and never touches candidate selection —
// that stays exactly as it is today.
//
// Deploy this as a Render "Background Worker" (or Railway/Fly.io — any
// platform that keeps a Node process running continuously). It needs three
// environment variables set wherever you deploy it:
//   FINNHUB_API_KEY        - same key already used inside Base44
//   BASE44_APP_URL         - e.g. https://berserk-pulse-trade-scan.base44.app
//   BASE44_API_KEY         - a Base44 API key with read/write access to
//                             this app's Position entity (generate this
//                             from the Base44 app's API settings)

import WebSocket from "ws";
import fetch from "node-fetch";

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const BASE44_APP_URL = process.env.BASE44_APP_URL;
const BASE44_API_KEY = process.env.BASE44_API_KEY;

if (!FINNHUB_API_KEY || !BASE44_APP_URL || !BASE44_API_KEY) {
  console.error("Missing required environment variables. Need FINNHUB_API_KEY, BASE44_APP_URL, BASE44_API_KEY.");
  process.exit(1);
}

const SYNC_INTERVAL_MS = 5 * 60 * 1000; // re-check open positions every 5 min
const RECONNECT_DELAY_MS = 5000;

// In-memory map of what we're watching: symbol -> { positionId, side, stop, entryPrice }
// Only ONE entry per symbol is kept (if somehow two positions share a symbol,
// last-synced wins — this should be rare given the app's one-per-symbol-per-day rule).
let watchList = new Map();
let ws = null;
let currentSubscriptions = new Set();

// --- Fetch current open positions + their stops from Base44 ---
async function syncOpenPositions() {
  try {
    const res = await fetch(`${BASE44_APP_URL}/api/entities/Position?status=open`, {
      headers: { "Authorization": `Bearer ${BASE44_API_KEY}` },
    });
    if (!res.ok) {
      console.error(`Sync failed: ${res.status} ${res.statusText}`);
      return;
    }
    const positions = await res.json();
    const newWatchList = new Map();
    for (const p of positions) {
      newWatchList.set(p.symbol.toUpperCase(), {
        positionId: p.id,
        side: p.side,
        stop: Number(p.current_stop),
        entryPrice: Number(p.entry_price),
      });
    }
    watchList = newWatchList;
    updateSubscriptions();
    console.log(`Synced ${watchList.size} open position(s): ${[...watchList.keys()].join(", ") || "(none)"}`);
  } catch (err) {
    console.error("Sync error:", err.message);
  }
}

// --- Keep Finnhub subscriptions matched to the current watch list ---
function updateSubscriptions() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const needed = new Set(watchList.keys());

  for (const sym of currentSubscriptions) {
    if (!needed.has(sym)) {
      ws.send(JSON.stringify({ type: "unsubscribe", symbol: sym }));
      currentSubscriptions.delete(sym);
    }
  }
  for (const sym of needed) {
    if (!currentSubscriptions.has(sym)) {
      ws.send(JSON.stringify({ type: "subscribe", symbol: sym }));
      currentSubscriptions.add(sym);
    }
  }
}

// --- Check a live tick against the watched stop; fire an urgent close if crossed ---
async function handleTick(symbol, price) {
  const pos = watchList.get(symbol);
  if (!pos) return;

  const crossed = pos.side === "long" ? price <= pos.stop : price >= pos.stop;
  if (!crossed) return;

  watchList.delete(symbol);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "unsubscribe", symbol }));
    currentSubscriptions.delete(symbol);
  }

  console.log(`STOP CROSSED: ${symbol} ${pos.side} stop=${pos.stop} tick=${price} — closing now`);

  try {
    const res = await fetch(`${BASE44_APP_URL}/api/functions/realtimeStopClose`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${BASE44_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        positionId: pos.positionId,
        symbol,
        realtimePrice: price,
      }),
    });
    if (!res.ok) {
      console.error(`Close request failed for ${symbol}: ${res.status} ${await res.text()}`);
    } else {
      console.log(`Close confirmed for ${symbol}.`);
    }
  } catch (err) {
    console.error(`Close request error for ${symbol}:`, err.message);
  }
}

// --- Finnhub WebSocket connection, with auto-reconnect ---
function connect() {
  ws = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_API_KEY}`);

  ws.on("open", () => {
    console.log("Connected to Finnhub WebSocket.");
    currentSubscriptions = new Set();
    updateSubscriptions();
  });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    if (msg.type !== "trade" || !Array.isArray(msg.data)) return;
    for (const tick of msg.data) {
      handleTick(String(tick.s).toUpperCase(), Number(tick.p));
    }
  });

  ws.on("close", () => {
    console.log(`WebSocket closed. Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
    setTimeout(connect, RECONNECT_DELAY_MS);
  });

  ws.on("error", (err) => {
    console.error("WebSocket error:", err.message);
  });
}

// --- Start up ---
console.log("Starting real-time stop-monitoring worker...");
syncOpenPositions().then(() => {
  connect();
  setInterval(syncOpenPositions, SYNC_INTERVAL_MS);
});
