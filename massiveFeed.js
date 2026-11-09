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
import { admitPrice, SOURCE_LIMITS } from "./tradeConditions.js";

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
const finnhubPrice = new Map(); // symbol -> { price, at, tMs } — shadow comparison only
const lastTrade = new Map();    // symbol -> { price, at }

const stats = { connects: 0, closes: 0, trades: 0, reconnects: 0, refusals: 0, lastError: null };
const shadow = { samples: 0, within: 0, sumAbsDelta: 0, widest: 0 };

// ------------------------------------------------------------
// LAG MEASUREMENT (shadow mode only)
//
// "Which feed is more current?" is a question about TRANSIT: how long a print takes
// to reach this process after the venue stamped it. Both providers stamp their own
// prints — Massive on the trade frame (`t`), Finnhub on the trade object (`t`) — so
// every print is measured against the same arrival clock:
//
//   transit = arrival − exchange stamp
//
// The feed with the smaller transit hands this worker the fresher price; the gap
// between the two means is the head start one feed has over the other. Nothing here
// can change a decision: it observes prints that have already been routed (or, in
// shadow mode, not routed at all).
//
// The second question — do the price differences come FROM lag? — is answered by
// bucketing every compared pair by how far apart its two prints were in EXCHANGE
// time. If prices still disagree when the two prints are within a tenth of a
// second, the disagreement is not delivery lag.
// ------------------------------------------------------------
const TRANSIT_BUCKETS = [100, 500, 1000, 2000, 5000]; // ms upper bounds
const PAIR_BUCKETS = [100, 500, 1000, 5000];          // ms upper bounds on print gap

function emptyTransit() {
  return {
    n: 0, sum: 0,
    nostamp: 0,   // print carried no usable exchange stamp
    outliers: 0,  // stamp in the future or far in the past — a clock disagreement, not a delay
    buckets: TRANSIT_BUCKETS.map(() => 0),
    over: 0,
  };
}

const lag = {
  massive: emptyTransit(),
  finnhub: emptyTransit(),
  pairs: PAIR_BUCKETS.map((max) => ({ max, n: 0, sumAbs: 0, within: 0 })),
  pairsUnstamped: 0,
};

function noteTransit(bucket, exchangeMs, at) {
  const stamp = Number(exchangeMs);
  if (!Number.isFinite(stamp) || stamp <= 0) {
    bucket.nostamp += 1;
    return;
  }
  const transit = at - stamp;
  if (!Number.isFinite(transit) || transit < -2000 || transit > 120000) {
    bucket.outliers += 1;
    return;
  }
  bucket.n += 1;
  bucket.sum += transit;
  if (transit <= 100) bucket.buckets[0] += 1;
  else if (transit <= 500) bucket.buckets[1] += 1;
  else if (transit <= 1000) bucket.buckets[2] += 1;
  else if (transit <= 2000) bucket.buckets[3] += 1;
  else if (transit <= 5000) bucket.buckets[4] += 1;
  else bucket.over += 1;
}

// Smallest bucket upper bound holding at least `share` of the samples, from the
// retained buckets. Null means the tail was slower than the last bucket.
function percentileOf(bucket, share) {
  if (!bucket.n) return null;
  const target = bucket.n * share;
  let seen = 0;
  for (let i = 0; i < bucket.buckets.length; i += 1) {
    seen += bucket.buckets[i];
    if (seen >= target) return TRANSIT_BUCKETS[i];
  }
  return null;
}

function transitText(bucket) {
  if (!bucket.n) {
    return `no stamped prints yet${bucket.nostamp ? ` (${bucket.nostamp} unstamped)` : ""}`;
  }
  const p50 = percentileOf(bucket, 0.5);
  const p90 = percentileOf(bucket, 0.9);
  return (
    `n=${bucket.n} mean=${Math.round(bucket.sum / bucket.n)}ms` +
    ` p50=${p50 == null ? ">5000ms" : `<=${p50}ms`}` +
    ` p90=${p90 == null ? ">5000ms" : `<=${p90}ms`}` +
    (bucket.outliers ? ` outliers=${bucket.outliers}` : "")
  );
}

function lagLines() {
  const pairText = lag.pairs
    .map((b) =>
      `<=${b.max}ms n=${b.n}` +
      ` mean|d|=${b.n ? `$${(b.sumAbs / b.n).toFixed(4)}` : "-"}` +
      ` within5c=${b.n ? `${((100 * b.within) / b.n).toFixed(1)}%` : "-"}`
    )
    .join(" | ");
  return [
    `[lag] transit — massive ${transitText(lag.massive)} || finnhub ${transitText(lag.finnhub)}`,
    `[lag] price gap by print gap — ${pairText}` +
      (lag.pairsUnstamped ? ` || ${lag.pairsUnstamped} pairs without stamps` : ""),
  ];
}

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
      // Cumulative lag totals, so the last line before the close is the whole
      // session's measurement and needs no reconstruction from samples.
      if (mode === "shadow") for (const line of lagLines()) console.log(line);
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
// feeds are compared on the same symbol at (almost) the same instant. It also
// carries Finnhub's own stamp for the print (`t`, epoch ms), which is what makes the
// transit measurement possible — the same measurement Massive's prints get below.
export function noteFinnhubPrice(symbol, price, exchangeMs) {
  if (mode !== "shadow") return;
  const numeric = Number(price);
  if (!Number.isFinite(numeric) || numeric <= 0) return;
  const at = Date.now();
  const stamp = Number(exchangeMs);
  const tMs = Number.isFinite(stamp) && stamp > 0 ? stamp : null;
  finnhubPrice.set(String(symbol || "").toUpperCase(), { price: numeric, at, tMs });
  noteTransit(lag.finnhub, tMs, at);
}

// Quiet-symbol fallback: one snapshot per symbol, no per-minute ceiling.
// A snapshot's last trade older than this describes a finished tape, not a live
// price. Same limit as the Finnhub paths — one table for all of them (tradeConditions.SOURCE_LIMITS).
export const SNAPSHOT_MAX_TRADE_AGE_MS = SOURCE_LIMITS.massive_snapshot;

// Massive stamps its trades in a compact epoch (measured on this key: microseconds).
// Resolve the unit from the magnitude instead of assuming one, so the age is real.
function stampToMs(stamp) {
  const n = Number(stamp);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1e17) return n / 1e6; // nanoseconds
  if (n >= 1e14) return n / 1e3; // microseconds
  if (n >= 1e12) return n;       // milliseconds
  return n * 1000;               // seconds
}

// Everything else the frame says about the print, kept with the price so the consumer can
// judge whether it is a price at all (tradeConditions.js):
//   c    — the sale conditions the SIP stamped on it (Massive: /v3/reference/conditions)
//   pt   — when the trade occurred at the exchange or TRF
//   trft — when the TRF received it; trfi — which TRF
//   q    — the tape sequence number
// Reading only sym and p is what let the 2026-11-09 TRF flush through: the tape had
// labelled every print condition 13, "Extended Hours (Sold Out Of Sequence)", for trades
// executed before 05:00 ET.
function printMeta(frame) {
  return {
    conditions: Array.isArray(frame.c) ? frame.c.map(Number) : [],
    participantMs: stampToMs(frame.pt),
    trfMs: stampToMs(frame.trft),
    trfId: frame.trfi != null ? Number(frame.trfi) : null,
    sequence: frame.q != null ? Number(frame.q) : null,
  };
}

// One snapshot, as a PRINT rather than a bare number: the price, its own trade stamp, its
// sale conditions and its exchange. A bare number cannot be judged — and on 2026-11-09 the
// snapshot path was the one that could reprice a position with nothing to check it against.
function parseSnapshot(body) {
  const ticker = body?.ticker || null;
  const last = ticker?.lastTrade || null;

  // ONLY the last trade is a price. day.c and min.c are the session's and the minute's close
  // — the last value of a dead tape — so they are never a substitute: a symbol with no recent
  // print returns null and waits.
  const price = Number(last?.p);
  if (!Number.isFinite(price) || price <= 0) return null;

  return {
    price,
    stampMs: stampToMs(last?.t),
    exchange: last?.x != null ? Number(last.x) : null,
    conditions: Array.isArray(last?.c) ? last.c.map(Number) : [],
  };
}

// The snapshot as a print. No age check here on purpose: the caller hands it to the ONE gate
// (tradeConditions.admitPrice), which applies the same freshness, provenance and monotonic
// tape tests a stream print gets, so the two doors cannot drift apart.
export async function snapshotTick(symbol) {
  if (!apiKey) return null;
  try {
    const res = await fetch(
      `${SNAPSHOT_URL}/${encodeURIComponent(symbol)}?apiKey=${apiKey}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    return parseSnapshot(body);
  } catch (err) {
    stats.lastError = String(err?.message || err).slice(0, 120);
    return null;
  }
}

// The snapshot as a number, for the 16:00 close, which asks the market for a price and labels
// what it gets. It is judged by the SAME gate as a stream print — age, sale conditions and the
// monotonic tape test — so a re-publication flushed near the close cannot price a fill either.
// AGE ONLY, NEVER MAGNITUDE: a snapshot at a new level is how a halted-and-resumed symbol is
// recovered, so its distance from this worker's last price is not a reason to refuse it.
export async function snapshotPrice(symbol) {
  const tick = await snapshotTick(symbol);
  if (!tick) return null;

  const verdict = admitPrice({
    source: "massive_snapshot",
    symbol,
    price: tick.price,
    stampMs: tick.stampMs,
    conditions: tick.conditions,
  });
  if (verdict.tier !== "use") {
    console.warn(`[quote] ${symbol} REJECTED — Massive snapshot ${verdict.reason}`);
    return null;
  }
  return tick.price;
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

// The lag measurement as data: each feed's transit (arrival − exchange stamp) and
// the price gap split by print gap. Purely observational — no trading code reads it.
export function lagSummary() {
  const describe = (b) => ({
    stamped: b.n,
    meanMs: b.n ? Math.round(b.sum / b.n) : null,
    p50Ms: percentileOf(b, 0.5),
    p90Ms: percentileOf(b, 0.9),
    unstamped: b.nostamp,
    outliers: b.outliers,
  });
  return {
    massive: describe(lag.massive),
    finnhub: describe(lag.finnhub),
    pairs: lag.pairs.map((b) => ({
      printGapMs: b.max,
      n: b.n,
      meanAbsDelta: b.n ? +(b.sumAbs / b.n).toFixed(4) : null,
      within5cPct: b.n ? +((100 * b.within) / b.n).toFixed(1) : null,
    })),
    pairsUnstamped: lag.pairsUnstamped,
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
      // The frame carries the venue's own stamp; keeping it is what lets this print
      // be measured against its arrival time (and against Finnhub's print). Its
      // provenance — the sale conditions and the execution time — travels with it too.
      if (symbol && Number.isFinite(price) && price > 0) {
        publish(symbol, price, stampToMs(frame.t), printMeta(frame));
      }
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

function publish(symbol, price, exchangeMs, meta) {
  const at = Date.now();
  stats.trades += 1;
  lastTrade.set(symbol, { price, at });
  noteTransit(lag.massive, exchangeMs, at);

  if (mode === "live") {
    try {
      // The venue's own stamp travels WITH the price, and so does everything else the
      // frame says about the print: the consumer is what decides whether it describes
      // the present (worker.js onMassivePrice, tradeConditions.js). Dropping these here
      // is what made a 14-hour-old execution look like a live price on 2026-11-09.
      if (onPrice) onPrice(symbol, price, exchangeMs, meta);
    } catch (err) {
      console.error(`[massive] route failed for ${symbol}: ${String(err?.message || err).slice(0, 120)}`);
    }
    return;
  }

  compareWithFinnhub(symbol, price, exchangeMs);
}

// Shadow mode only: how far apart are the two feeds on the same symbol?
function compareWithFinnhub(symbol, price, exchangeMs) {
  const reference = finnhubPrice.get(symbol);
  if (!reference || Date.now() - reference.at > SHADOW_WINDOW_MS) return;

  const delta = Math.abs(price - reference.price);
  shadow.samples += 1;
  shadow.sumAbsDelta += delta;
  if (delta <= 0.05) shadow.within += 1;

  // LAG CROSS-TAB: the same price difference, split by how far apart the two prints
  // were in exchange time. A pair stamped within 100 ms of each other describes the
  // same moment in the market, so if those pairs disagree as much as the wide ones,
  // the disagreement is between the two tapes, not between two delivery speeds.
  const stamp = Number(exchangeMs);
  if (!Number.isFinite(stamp) || stamp <= 0 || !reference.tMs) {
    lag.pairsUnstamped += 1;
  } else {
    const gap = Math.abs(stamp - reference.tMs);
    const bucket = lag.pairs.find((b) => gap <= b.max) || lag.pairs[lag.pairs.length - 1];
    bucket.n += 1;
    bucket.sumAbs += delta;
    if (delta <= 0.05) bucket.within += 1;
  }

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