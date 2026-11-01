// massiveFeed.js — Massive (ex-Polygon) real-time stocks stream, for DART.
//
// A PRICE SOURCE ONLY. It turns Massive trade events into the same (symbol, price)
// call the Finnhub socket made, so every rule, threshold, press, stop, size and
// accounting path stays exactly as it is. Nothing in this file decides anything.
//
// ENTITLEMENT (verified on this key, 2026-11-01): the real-time stocks cluster
// accepts auth and the T (trades), Q (quotes), A (second bars) and AM (minute bars)
// channels. The options cluster refuses the same key, which is what proves a
// refusal is visible rather than silent.
//
// MODES (the worker picks one from PRICE_FEED):
//   "live"   — every trade is handed to the worker's routeTick().
//   "shadow" — prices are only compared with the live Finnhub feed; nothing routes.
//   "off"    — this module does nothing.
//
// WHY IT DOES NOT HAVE THE FINNHUB PROBLEM: the socket stays open whether or not
// trades print (a permanent SPY subscription keeps it non-empty on an empty book),
// and the plan has no per-minute REST ceiling, so the quiet-symbol fallback cannot
// starve itself.

import WebSocket from "ws";
import fetch from "node-fetch";

const WS_URL = "wss://socket.massive.com/stocks";
const SNAPSHOT_URL = "https://api.massive.com/v2/snapshot/locale/us/markets/stocks/tickers";
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const KEEPALIVE_SYMBOL = "SPY";   // also the app's market reference
const SHADOW_WINDOW_MS = 5000;    // how recent a Finnhub print may be to compare against
const REPORT_EVERY_MS = 300000;

let apiKey = "";
let mode = "off";
let onPrice = null;
let socket = null;
let authed = false;
let reconnectTimer = null;
let attempts = 0;
let reportTimer = null;

const subs = new Set();
const finnhubPrice = new Map(); // symbol -> { price, at } — shadow comparison only
const lastTrade = new Map();    // symbol -> { price, at }

const stats = { connects: 0, closes: 0, trades: 0, reconnects: 0, refusals: 0, lastError: null };
const shadow = { samples: 0, within: 0, sumAbsDelta: 0, widest: 0 };

export function configure(key) {
  apiKey = String(key || "");
}

export function enable(nextMode, priceHandler) {
  mode = nextMode === "live" || nextMode === "shadow" ? nextMode : "off";
  onPrice = typeof priceHandler === "function" ? priceHandler : null;
}

export function enabled() {
  return mode !== "off" && Boolean(apiKey);
}

export function start() {
  if (!enabled()) return false;
  connect();
  if (!reportTimer) {
    reportTimer = setInterval(() => {
      const s = statsSummary();
      const sh = shadowSummary();
      console.log(
        `[massive] conn=${s.connects} closes=${s.closes} trades=${s.trades} refusals=${s.refusals}` +
        (sh.samples
          ? ` | shadow ${sh.samples} samples, ${sh.within} within $0.05, mean $${sh.mean.toFixed(3)}, widest $${sh.widest.toFixed(2)}`
          : "")
      );
    }, REPORT_EVERY_MS);
  }
  return true;
}

// Keep the subscription set equal to what is actually open, plus the keepalive.
export function setSymbols(symbols) {
  if (!enabled()) return;

  const want = new Set([KEEPALIVE_SYMBOL]);
  for (const symbol of symbols || []) {
    const upper = String(symbol || "").toUpperCase();
    if (upper) want.add(upper);
  }

  for (const symbol of [...subs]) {
    if (!want.has(symbol)) {
      subs.delete(symbol);
      send({ action: "unsubscribe", params: `T.${symbol}` });
    }
  }
  for (const symbol of want) {
    if (!subs.has(symbol)) {
      subs.add(symbol);
      send({ action: "subscribe", params: `T.${symbol}` });
    }
  }

  connect();
}

// The worker calls this for every Finnhub tick while in shadow mode, so the two
// feeds are compared on the same symbol at (almost) the same instant.
export function noteFinnhubPrice(symbol, price) {
  if (mode !== "shadow") return;
  const numeric = Number(price);
  if (!Number.isFinite(numeric) || numeric <= 0) return;
  finnhubPrice.set(String(symbol || "").toUpperCase(), { price: numeric, at: Date.now() });
}

// Quiet-symbol fallback: one snapshot per symbol, no per-minute ceiling.
export async function snapshotPrice(symbol) {
  if (!apiKey) return null;
  try {
    const res = await fetch(
      `${SNAPSHOT_URL}/${encodeURIComponent(symbol)}?apiKey=${apiKey}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    const ticker = body?.ticker || null;
    const price = Number(ticker?.lastTrade?.p ?? ticker?.day?.c ?? ticker?.min?.c);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch (err) {
    stats.lastError = String(err?.message || err).slice(0, 120);
    return null;
  }
}

export function statsSummary() {
  return { ...stats, mode, authed, subscriptions: subs.size, symbols: [...subs] };
}

export function shadowSummary() {
  return {
    samples: shadow.samples,
    within: shadow.within,
    widest: shadow.widest,
    mean: shadow.samples ? shadow.sumAbsDelta / shadow.samples : 0,
  };
}

// ------------------------------------------------------------
// SOCKET
// ------------------------------------------------------------

function send(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  try {
    socket.send(JSON.stringify(message));
  } catch (err) {
    stats.lastError = String(err?.message || err).slice(0, 120);
  }
}

function connect() {
  if (!enabled()) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  if (socket) {
    try { socket.removeAllListeners(); socket.terminate(); } catch (_) {}
    socket = null;
  }

  const next = new WebSocket(WS_URL);
  socket = next;
  authed = false;

  next.on("open", () => {
    if (socket !== next) return;
    stats.connects += 1;
    send({ action: "auth", params: apiKey });
  });

  next.on("message", (raw) => {
    if (socket !== next) return;
    handle(raw);
  });

  next.on("close", () => {
    if (socket !== next) return;
    stats.closes += 1;
    authed = false;
    scheduleReconnect();
  });

  next.on("error", (err) => {
    if (socket !== next) return;
    stats.lastError = String(err?.message || err).slice(0, 120);
    try { next.terminate(); } catch (_) {}
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (reconnectTimer || !enabled()) return;
  attempts += 1;
  stats.reconnects += 1;
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, attempts - 1));
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function handle(raw) {
  let frames;
  try {
    frames = JSON.parse(raw.toString());
  } catch (_) {
    return;
  }

  for (const frame of Array.isArray(frames) ? frames : [frames]) {
    if (!frame || typeof frame !== "object") continue;

    if (frame.ev === "status") {
      onStatus(frame);
      continue;
    }

    if (frame.ev === "T") {
      const symbol = String(frame.sym || "").toUpperCase();
      const price = Number(frame.p);
      if (symbol && Number.isFinite(price) && price > 0) publish(symbol, price);
    }
  }
}

function onStatus(frame) {
  const status = String(frame.status || "").toLowerCase();
  const message = String(frame.message || "").toLowerCase();

  if (status === "auth_success") {
    authed = true;
    attempts = 0;
    console.log(`[massive] authenticated — ${subs.size} subscription(s), mode=${mode}`);
    // Re-issue every subscription: anything sent before auth completed was ignored.
    for (const symbol of subs) send({ action: "subscribe", params: `T.${symbol}` });
    return;
  }

  if (status.includes("not_author") || message.includes("not_author")) {
    stats.refusals += 1;
    stats.lastError = `${status}:${message}`.slice(0, 120);
    console.error(`[massive] subscription refused by the provider — ${stats.lastError}`);
    return;
  }

  if (status === "error" || status === "auth_failed") {
    stats.lastError = `${status}:${message}`.slice(0, 120);
    console.error(`[massive] provider status ${stats.lastError}`);
  }
}

function publish(symbol, price) {
  stats.trades += 1;
  lastTrade.set(symbol, { price, at: Date.now() });

  if (mode === "live") {
    try {
      if (onPrice) onPrice(symbol, price);
    } catch (err) {
      console.error(`[massive] route failed for ${symbol}: ${String(err?.message || err).slice(0, 120)}`);
    }
    return;
  }

  compareWithFinnhub(symbol, price);
}

// Shadow mode only: how far apart are the two feeds on the same symbol?
function compareWithFinnhub(symbol, price) {
  const reference = finnhubPrice.get(symbol);
  if (!reference || Date.now() - reference.at > SHADOW_WINDOW_MS) return;

  const delta = Math.abs(price - reference.price);
  shadow.samples += 1;
  shadow.sumAbsDelta += delta;
  if (delta <= 0.05) shadow.within += 1;
  if (delta > shadow.widest) {
    shadow.widest = delta;
    console.log(
      `[massive-shadow] ${symbol} widest gap so far $${delta.toFixed(2)} ` +
      `(massive ${price} vs finnhub ${reference.price})`
    );
  }
}