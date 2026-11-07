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
// Massive allows ONE live stream per account. A close with 1008 (policy violation)
// means our new socket collided with the session we just left, so retrying a second
// later is what turns one refusal into an endless handshake ping-pong. A blocked
// close therefore waits this long, letting the provider release the old session.
const RECONNECT_BLOCKED_MS = 60000;
const CONNECTION_STABLE_MS = 60000;
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
let openedAt = Date.now();
let stableTimer = null;
// Every socket this module has created and not yet seen close. The one-stream guard
// reads this, not the `socket` pointer.
const live = new Set();

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
// A snapshot's last trade older than this describes a finished tape, not a live
// price. Same limit as the Finnhub quiet-symbol guard (FALLBACK_MAX_QUOTE_AGE_MS).
export const SNAPSHOT_MAX_TRADE_AGE_MS = 60000;

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

    // ONLY the last trade is a price. day.c and min.c are the session's and the
    // minute's close — the last value of a dead tape — so they are never a
    // substitute: a symbol with no recent print returns null and waits.
    const price = Number(ticker?.lastTrade?.p);
    const stamp = Number(ticker?.lastTrade?.t);
    const tradeMs = Number.isFinite(stamp) && stamp > 0 ? (stamp >= 1e12 ? stamp : stamp * 1000) : null;
    const ageMs = tradeMs == null ? null : Date.now() - tradeMs;

    if (!Number.isFinite(price) || price <= 0) return null;
    if (ageMs == null || ageMs < 0 || ageMs > SNAPSHOT_MAX_TRADE_AGE_MS) {
      console.warn(
        `[quote] ${symbol} REJECTED — ` +
        (ageMs == null
          ? "Massive snapshot carries no trade timestamp"
          : ageMs < 0
            ? `Massive snapshot trade stamp is ${Math.round(-ageMs / 1000)}s in the future`
            : `Massive snapshot trade is ${Math.round(ageMs / 1000)}s old`) +
        ` (limit ${SNAPSHOT_MAX_TRADE_AGE_MS / 1000}s)`
      );
      return null;
    }
    return price;
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
  // Nothing except auth may be sent before the stream has authenticated: an
  // unauthenticated subscribe is itself a policy violation (close code 1008).
  if (message?.action !== "auth" && !authed) return;
  try {
    socket.send(JSON.stringify(message));
  } catch (err) {
    stats.lastError = String(err?.message || err).slice(0, 120);
  }
}

function connect() {
  if (!enabled()) return;

  // EXACTLY ONE STREAM, EVER. This account permits a single live stream: a second
  // one is closed by the provider with code 1008, which then closes the other, and
  // the pair fight forever. A socket is therefore only created when NO socket is
  // registered here at all — opening, open or closing, any of them blocks this —
  // and the close handler is the only thing that reconnects. `live` is the honest
  // count, so a duplicate can never hide behind the `socket` pointer again.
  if (live.size > 0) {
    if (live.size > 1) console.error(`[massive] ${live.size} sockets registered — keeping one`);
    return;
  }
  if (socket) {
    try { socket.removeAllListeners(); socket.terminate(); } catch (_) {}
    socket = null;
  }

  const next = new WebSocket(WS_URL);
  live.add(next);
  socket = next;
  authed = false;
  openedAt = Date.now();

  next.on("open", () => {
    if (socket !== next) return;
    stats.connects += 1;
    send({ action: "auth", params: apiKey });
  });

  next.on("message", (raw) => {
    if (socket !== next) return;
    handle(raw);
  });

  next.on("close", (code, reason) => {
    if (socket !== next) return;
    stats.closes += 1;
    stats.lastClose = { code, reason: String(reason || "").slice(0, 80) };
    authed = false;
    clearTimeout(stableTimer);

    // Retire this socket completely before the retry opens its successor, so the next
    // connection cannot be judged a second stream alongside this one.
    live.delete(next);
    try { next.removeAllListeners(); next.terminate(); } catch (_) {}
    socket = null;

    // 1008 = policy violation (Massive's "one live stream per account" refusal).
    // Anything else keeps the ordinary ladder.
    const blocked = code === 1008 || code === 1013;
    if (blocked) stats.refusals += 1;

    console.log(
      `[massive] socket closed — code ${code}${reason ? `, reason "${String(reason).slice(0, 80)}"` : ""}` +
      `, lived ${Math.round((Date.now() - openedAt) / 1000)}s` +
      (blocked ? " (provider refused a second stream — waiting 60s)" : "")
    );
    scheduleReconnect(blocked);
  });

  next.on("error", (err) => {
    if (socket !== next) return;
    stats.lastError = String(err?.message || err).slice(0, 120);
    console.error(`[massive] socket error: ${stats.lastError}`);
    // Retire the socket and NOTHING else. An error is always followed by a close,
    // and the close is the only place that knows the close code — so it alone
    // decides how long to wait. Scheduling here would arm a 1-second retry that
    // defeats the refusal wait.
    try { next.terminate(); } catch (_) {}
  });
}

function scheduleReconnect(blocked = false) {
  if (!enabled()) return;
  // A refusal always wins over a shorter wait that is already pending.
  if (reconnectTimer && blocked) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (reconnectTimer) return;
  attempts += 1;
  stats.reconnects += 1;
  const delay = blocked
    ? RECONNECT_BLOCKED_MS
    : Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, attempts - 1));
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
    console.log(`[massive] authenticated — ${subs.size} subscription(s), mode=${mode}, streams=${live.size}`);
    // Re-issue every subscription: anything sent before auth completed was ignored.
    for (const symbol of subs) send({ action: "subscribe", params: `T.${symbol}` });

    // Reset the retry ladder only once a connection has actually HELD for a while —
    // the same lesson the Finnhub socket taught: resetting on connect turns a
    // takeover into a 1-second reconnect loop.
    clearTimeout(stableTimer);
    stableTimer = setTimeout(() => {
      if (socket && socket.readyState === WebSocket.OPEN && authed) {
        attempts = 0;
        console.log(`[massive] stream stable for ${CONNECTION_STABLE_MS / 1000}s — reconnect ladder reset`);
      }
    }, CONNECTION_STABLE_MS);
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

// Close the stream the moment this process is asked to stop. A redeploy that leaves
// its old socket holding the account's one stream is exactly what makes the next
// instance's connection a "second stream" and gets it closed with 1008.
export function shutdown() {
  clearTimeout(reconnectTimer);
  clearTimeout(stableTimer);
  reconnectTimer = null;
  for (const s of live) {
    try { s.removeAllListeners(); s.terminate(); } catch (_) {}
  }
  live.clear();
  socket = null;
  authed = false;
}