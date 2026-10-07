// worker.js - Render tick-router for DART A/B/C live forward-test (PAPER).
//
// Finnhub supplies live WebSocket ticks (with a REST /quote fallback for
// quiet symbols). Base44 owns ALL trading math - dartLiveA, dartLiveB and
// dartLiveC each compute stops, presses, exits and (for B/C) the Vector 65
// from the live tick P&L. This worker discovers open positions across all
// three systems from getMonitoringStateAll, subscribes to each unique symbol
// once, and routes every tick to the handler specified for each position.
//
// The same symbol can be open in A, B and C at the same time; each tick for
// that symbol is forwarded independently to each system's handler.
//
// Handler contract (identical for dartLiveA / dartLiveB / dartLiveC):
//   POST {BASE44_APP_URL}/functions/{handler}
//   Authorization: Bearer <BASE44_API_KEY>
//   body: { positionId, symbol, realtimePrice }
//
// Paper trading only. All values are USD.

import WebSocket from "ws";
import fetch from "node-fetch";

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const BASE44_APP_URL = (process.env.BASE44_APP_URL || "").replace(/\/$/, "");
const BASE44_API_KEY = process.env.BASE44_API_KEY;

if (!FINNHUB_API_KEY || !BASE44_APP_URL || !BASE44_API_KEY) {
  console.error(
    "Missing required environment variables. Need FINNHUB_API_KEY, BASE44_APP_URL, BASE44_API_KEY."
  );
  process.exit(1);
}

const FINNHUB_WS_URL = "wss://ws.finnhub.io?token=" + FINNHUB_API_KEY;

// Consolidated monitoring endpoint - returns open positions for A, B and C
// in one response, each with its `system` and `handler` routing field.
const MONITOR_ENDPOINT =
  `${BASE44_APP_URL}/functions/getMonitoringStateAll`;

const SYNC_INTERVAL_MS = 15000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

// REST /quote fallback for symbols that haven't ticked on the WebSocket.
const POLL_LOOP_MS = 3000;
const QUIET_TICK_MS = 8000;

// symbol -> Array<{ positionId, handler, system }>
const symbolPositions = new Map();

// symbol -> ms of last price seen (WS tick or REST quote)
const lastTick = new Map();

// positionId -> true while a tick request is in flight (prevents double-fire)
const busy = new Set();

let ws = null;
let reconnectTimer = null;
let reconnectAttempts = 0;


// ------------------------------------------------------------
// BASE44 POSITION SYNC (A + B + C)
// ------------------------------------------------------------

async function fetchOpenPositions() {
  const res = await fetch(MONITOR_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${BASE44_API_KEY}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`getMonitoringStateAll HTTP ${res.status} ${res.statusText}`);
  }

  const body = await res.json();
  if (Array.isArray(body.positions)) return body.positions;
  if (Array.isArray(body)) return body;
  if (Array.isArray(body.items)) return body.items;
  if (Array.isArray(body.data)) return body.data;
  return [];
}

async function syncWithBase44() {
  try {
    const items = await fetchOpenPositions();

    // Build the new symbol -> positions map from the response.
    const next = new Map();
    const seenSymbols = new Set();
    let countA = 0, countB = 0, countC = 0;

    for (const it of items) {
      const symbol = String(it.symbol || "").toUpperCase();
      if (!symbol) continue;
      seenSymbols.add(symbol);

      const system = String(it.system || "").toUpperCase();
      const handler = String(it.handler || "");
      const positionId = String(it.id || "");
      if (!positionId || !handler) continue;

      if (system === "A") countA++;
      else if (system === "B") countB++;
      else if (system === "C") countC++;

      if (!next.has(symbol)) next.set(symbol, []);
      next.get(symbol).push({ positionId, handler, system });
    }

    // Subscribe to newly seen symbols, unsubscribe from dropped ones.
    const prevSymbols = new Set(symbolPositions.keys());
    for (const symbol of seenSymbols) {
      if (!prevSymbols.has(symbol)) {
        wsSend({ type: "subscribe", symbol });
        console.log(`[sync] + ${symbol}`);
      }
    }

    for (const symbol of prevSymbols) {
      if (!seenSymbols.has(symbol)) {
        wsSend({ type: "unsubscribe", symbol });
        lastTick.delete(symbol);
        console.log(`[sync] - ${symbol} (no longer open)`);
      }
    }

    symbolPositions.clear();
    for (const [k, v] of next) symbolPositions.set(k, v);

    console.log(
      `[sync] ${symbolPositions.size} symbol(s), ${items.length} position(s) ` +
      `[A=${countA} B=${countB} C=${countC}]` +
      (symbolPositions.size ? ": " + Array.from(symbolPositions.keys()).join(", ") : "")
    );
  } catch (err) {
    console.error("[sync] error:", err.message);
  }
}


// ------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function fmt(n) {
  if (n == null || !Number.isFinite(Number(n))) return "n/a";
  return Number(n).toFixed(2);
}


// ------------------------------------------------------------
// TICK ROUTING - forward one tick to one position's handler
// ------------------------------------------------------------

async function forwardTick(ref, symbol, price) {
  // One in-flight request per positionId (prevents double-fire).
  if (busy.has(ref.positionId)) return;
  busy.add(ref.positionId);

  try {
    const res = await fetch(`${BASE44_APP_URL}/functions/${ref.handler}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${BASE44_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        positionId: ref.positionId,
        symbol,
        realtimePrice: price,
      }),
    });

    let body = null;
    try { body = await res.json(); } catch (_) {}

    if (res.status === 404) {
      console.log(`[${ref.system}] ${symbol} -> ${ref.handler}: position not found`);
      return;
    }

    if (res.status === 409) {
      console.error(`[${ref.system}] ${symbol} -> ${ref.handler}: symbol mismatch`, body);
      return;
    }

    if (!res.ok) {
      console.error(`[${ref.system}] ${symbol} -> ${ref.handler}: HTTP ${res.status} ${JSON.stringify(body)}`);
      return;
    }

    // Log meaningful events only. Holds are silent.
    if (body?.closed) {
      console.log(`[${ref.system}] ${symbol} ${ref.handler}: CLOSED ${body.exit_reason || ""} pl=${fmt(body.pl)} net=${fmt(body.net_pl)}`);
    } else if (body?.applied) {
      console.log(`[${ref.system}] ${symbol} ${ref.handler}: ${body.event || "applied"} pl=${fmt(body.pl)}`);
    }
    // already_closed / already_applied / hold: silent.
  } catch (err) {
    console.error(`[${ref.system}] ${symbol} -> ${ref.handler}: ${err.message}`);
  } finally {
    busy.delete(ref.positionId);
  }
}

async function routeTick(symbol, price) {
  lastTick.set(symbol, Date.now());

  const refs = symbolPositions.get(symbol);
  if (!refs || refs.length === 0) return;

  // A, B, C are independent - forward in parallel.
  await Promise.allSettled(refs.map((ref) => forwardTick(ref, symbol, price)));
}


// ------------------------------------------------------------
// FINNHUB WEBSOCKET
// ------------------------------------------------------------

function wsSend(message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function connectWebSocket() {
  console.log("Connecting to Finnhub WebSocket...");

  ws = new WebSocket(FINNHUB_WS_URL);

  ws.on("open", () => {
    // Reset backoff on a successful connection.
    reconnectAttempts = 0;

    console.log("Connected to Finnhub WebSocket");

    // Re-subscribe everything after reconnect.
    for (const symbol of symbolPositions.keys()) {
      wsSend({ type: "subscribe", symbol });
    }
  });

  ws.on("message", (raw) => {
    let message;

    try {
      message = JSON.parse(raw.toString());
    } catch (_) {
      return;
    }

    if (message.type === "trade" && Array.isArray(message.data)) {
      for (const trade of message.data) {
        const symbol = String(trade.s || "").toUpperCase();
        const price = Number(trade.p);

        if (symbol && Number.isFinite(price) && price > 0) {
          routeTick(symbol, price);
        }
      }

      return;
    }

    if (message.type === "error") {
      console.error("[ws] Finnhub error:", message.msg);
    }
  });

  ws.on("close", () => {
    console.log("Finnhub WebSocket disconnected");
    scheduleReconnect();
  });

  ws.on("error", (err) => {
    console.error("[ws] error:", err.message);
    scheduleReconnect();
  });
}


// ------------------------------------------------------------
// RECONNECT
// ------------------------------------------------------------

function scheduleReconnect() {
  if (reconnectTimer) return;

  reconnectAttempts += 1;

  const delay = Math.min(
    RECONNECT_MAX_MS,
    RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts - 1)
  );

  console.log(`[ws] reconnecting in ${delay} ms (attempt ${reconnectAttempts})`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, delay);
}


// ------------------------------------------------------------
// REST /quote FALLBACK FOR QUIET SYMBOLS
//
// Finnhub's WebSocket only emits a tick when a trade prints.
// For any tracked symbol that hasn't ticked in QUIET_TICK_MS,
// pull a price from REST /quote and run the same routing.
// ------------------------------------------------------------

async function pollQuietSymbols() {
  const now = Date.now();

  for (const symbol of symbolPositions.keys()) {
    const last = lastTick.get(symbol) || 0;

    if (now - last < QUIET_TICK_MS) continue;

    try {
      const res = await fetch(
        `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FINNHUB_API_KEY}`
      );

      if (!res.ok) continue;

      const q = await res.json();
      const price = numberOrNull(q && q.c);

      if (price && price > 0) {
        routeTick(symbol, price);
      }
    } catch (err) {
      console.error(`[quote] ${symbol} error:`, err.message);
    }
  }
}


// ------------------------------------------------------------
// START
// ------------------------------------------------------------

async function start() {
  console.log("Starting DART A/B/C real-time tick router (paper, USD)...");

  // Discover open positions across A, B and C.
  await syncWithBase44();

  // Start live Finnhub feed.
  connectWebSocket();

  // Discover newly opened / replacement positions quickly.
  setInterval(syncWithBase44, SYNC_INTERVAL_MS);

  // Catch events on quiet symbols.
  setInterval(pollQuietSymbols, POLL_LOOP_MS);
}

start().catch((err) => {
  console.error("Worker startup failed:", err);
  process.exit(1);
});
