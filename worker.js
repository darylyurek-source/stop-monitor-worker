// worker.js - Render tick-router for DART New A / B / C / A+ live forward-test (PAPER).
//
// Finnhub supplies live WebSocket ticks (with a REST /quote fallback for
// quiet symbols). Base44 owns ALL trading math - dartLiveNewA, dartLiveB,
// dartLiveC and dartLiveAPlus each compute stops, presses, exits and the
// Vector 65 from the live tick P&L. This worker discovers open positions across
// all four systems from getMonitoringStateAll, subscribes to each unique symbol
// once, and routes every tick to the handler specified for each position.
//
// The same symbol can be open in New A, B, C and A+ at the same time; each tick
// for that symbol is forwarded independently to each system's handler. No
// duplicate quote requests — each unique symbol is subscribed once.
//
// Handler contract (identical for dartLiveA / dartLiveB / dartLiveC):
//   POST {BASE44_APP_URL}/functions/{handler}
//   Authorization: Bearer <BASE44_API_KEY>
//   body: { positionId, symbol, realtimePrice }
//
// TICK DELIVERY: each position has its own one-slot, latest-price-wins mailbox.
// While a position's request is in flight, arriving prices overwrite that single
// pending slot instead of being discarded, and the pending price is sent the
// moment the request settles - so the handler always decides on the newest price
// and a stop crossing is never held up behind a busy request. Exactly one request
// per position is ever in flight, so a price can never be processed twice.
//
// FEED DISCIPLINE: exactly one Finnhub socket is ever held. A socket that is still
// live is never replaced, a finished one is retired before its successor opens, a
// replaced socket's events are ignored, and the retry ladder is damped — a refused
// handshake waits a full minute, and the backoff only resets after a connection has
// held for a minute — so a refusal or a takeover cannot become a handshake
// ping-pong between two clients fighting over the one stream.
//
// Paper trading only. All values are USD.

import WebSocket from "ws";
import fetch from "node-fetch";
import * as engineShadow from "./engineShadow.js";
import * as positionBook from "./positionBook.js";
import { configure as configureBridge } from "./bridge.js";
import * as massiveFeed from "./massiveFeed.js";

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const BASE44_APP_URL = (process.env.BASE44_APP_URL || "").replace(/\/$/, "");
const BASE44_API_KEY = process.env.BASE44_API_KEY;

// Database bridge — needed by the read-only startup verification and by the engine's
// book and candle reads. NOT required in this service's environment: when they are
// missing, the worker asks Base44 for them at startup (getWorkerBridgeConfig, using
// the BASE44_API_KEY it already has), so nothing has to be pasted here. If that
// request fails the worker still routes every tick exactly as before.
let BRIDGE_URL = (process.env.BRIDGE_URL || "").replace(/\/$/, "");
let BRIDGE_API_KEY = process.env.BRIDGE_API_KEY;

// The market-data key the Massive stream authenticates with. Also resolved at
// startup from Base44 when it is not set on this service, so no secret has to be
// pasted into Render.
let MASSIVE_API_KEY = String(process.env.MASSIVE_API_KEY || "").trim();

// WHICH PRICE FEED ROUTES TICKS.
//   finnhub        — unchanged behaviour: the Finnhub socket routes every tick.
//   massive-shadow — Finnhub still routes; Massive connects and only COMPARES prices.
//   massive        — Massive routes every tick and the Finnhub socket is not opened.
//
// The feed supplies (symbol, price) and nothing else, so every trading rule,
// threshold, press, stop, size and exit is identical in all three modes. It is
// decided at startup, because the Massive key is resolved there.
let PRICE_FEED = "finnhub";

function resolveFeedMode() {
  const requested = String(process.env.PRICE_FEED || "finnhub").toLowerCase();
  if (requested === "finnhub") return "finnhub";
  if (!MASSIVE_API_KEY) {
    console.error(`[feed] PRICE_FEED=${requested} but no MASSIVE_API_KEY is available — staying on finnhub`);
    return "finnhub";
  }
  if (requested === "massive") return "massive";
  if (requested === "massive-shadow") return "massive-shadow";
  return "finnhub";
}

// Resolve the bridge connection at startup: from this service's own environment when
// present, otherwise from Base44. One request, before any tick or sync, so both the
// engine and the database verification see a configured bridge. Never throws.
async function resolveBridgeConfig() {
  if (BRIDGE_URL && BRIDGE_API_KEY) {
    console.log("[bridge-config] using this service's own BRIDGE_URL / BRIDGE_API_KEY");
    configureBridge(BRIDGE_URL, BRIDGE_API_KEY);
    return true;
  }

  try {
    const res = await fetch(`${BASE44_APP_URL}/functions/getWorkerBridgeConfig`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${BASE44_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      console.error(
        `[bridge-config] Base44 refused (HTTP ${res.status}) — engine idle and database verification skipped; tick routing unaffected`
      );
      return false;
    }

    const body = await res.json().catch(() => null);
    const url = String(body?.bridge_url || "").replace(/\/$/, "");
    const key = String(body?.bridge_api_key || "");
    if (!url || !key) {
      console.error(
        "[bridge-config] Base44 returned no bridge credentials — engine idle and database verification skipped; tick routing unaffected"
      );
      return false;
    }

    BRIDGE_URL = url;
    BRIDGE_API_KEY = key;
    configureBridge(url, key);
    console.log("[bridge-config] bridge credentials obtained from Base44 for this process");
    return true;
  } catch (err) {
    console.error(
      `[bridge-config] request failed (${err?.message || err}) — engine idle and database verification skipped; tick routing unaffected`
    );
    return false;
  }
}

// The Massive key, resolved the same way as the bridge: this service's own
// environment first, Base44 second. Never throws — a missing key simply leaves the
// Finnhub feed in charge.
async function resolveMassiveKey() {
  if (MASSIVE_API_KEY) {
    console.log("[worker-config] market-data key from this service's environment");
    return true;
  }

  try {
    const res = await fetch(`${BASE44_APP_URL}/functions/getWorkerBridgeConfig`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${BASE44_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      console.error(`[worker-config] market-data key unavailable (HTTP ${res.status}) — Finnhub stays the feed`);
      return false;
    }

    const body = await res.json().catch(() => null);
    MASSIVE_API_KEY = String(body?.massive_api_key || "").trim();
    console.log(
      MASSIVE_API_KEY
        ? "[worker-config] market-data key obtained from Base44"
        : "[worker-config] Base44 returned no market-data key — Finnhub stays the feed"
    );
    return Boolean(MASSIVE_API_KEY);
  } catch (err) {
    console.error(`[worker-config] market-data key request failed (${err?.message || err}) — Finnhub stays the feed`);
    return false;
  }
}

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

// The engine switchboard: which account the Render engine is attached to, and how
// far it may go (shadow records, live writes). Read on every sync — once per 15 s
// at most, never on the tick path.
const SWITCH_ENDPOINT = `${BASE44_APP_URL}/functions/getEngineSwitches`;

// SYNC CADENCE — how often this worker asks the app for the open book. While the
// session is live it keeps the 15-second cadence; when the app reports the market
// closed (night, weekend, NYSE holiday, early-close day) it drops to once a minute
// inside the trading day and once every five minutes outside it, so the poller costs
// almost nothing while nothing can trade. The app's answer decides — no calendar is
// duplicated here.
const SYNC_INTERVAL_OPEN_MS = 15000;
const SYNC_INTERVAL_CLOSED_MS = 60000;     // market closed, still inside the trading day
const SYNC_INTERVAL_OFFHOURS_MS = 300000;  // night or weekend: five minutes
const TRADING_DAY_FROM_MIN = 9 * 60 + 20;  // 9:20 AM ET
const TRADING_DAY_TO_MIN = 16 * 60 + 35;   // 4:35 PM ET
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
// A refused handshake (HTTP 429) means Finnhub is refusing a NEW connection, so it
// gets its own fixed wait and never the short end of the ladder.
const RECONNECT_RATE_LIMIT_MS = 60000;
// The backoff resets only once a connection has actually held this long. A
// connection that is accepted and taken over moments later must not re-arm the
// 1-second retry — that is what turns a takeover into a handshake ping-pong.
const CONNECTION_STABLE_MS = 60000;

// Hard timeout for each tick-forward HTTP request. If the Base44 handler
// never returns (platform stalls, dropped connection), the AbortController
// fires after this many ms so the position is never permanently locked out of
// tick processing - its mailbox still drains with its latest pending price.
const TICK_TIMEOUT_MS = 15000;

// REST /quote fallback for symbols that haven't ticked on the WebSocket.
const POLL_LOOP_MS = 3000;
const QUIET_TICK_MS = 8000;

// symbol -> Array<{ positionId, handler, system }>
const symbolPositions = new Map();

// symbol -> ms of last price seen (WS tick or REST quote)
const lastTick = new Map();

// positionId -> one-slot mailbox carrying that position's next price.
//
//   { inFlight: boolean, pending: { ref, symbol, price } | null }
//
// ONE SLOT, LATEST PRICE WINS. A price arriving while that position's previous
// request is still in flight is kept - it overwrites the single pending slot -
// and is processed the moment the in-flight request settles. No price is ever
// discarded, so the newest price is always the one the handler decides on, and a
// stop crossing is seen after one request round-trip instead of being skipped
// while a request is busy. Every position has its own mailbox, so a slow handler
// in one system never holds up another system's ticks.
//
// This changes WHEN a price reaches the handler, never the price itself and never
// a trading rule: no threshold, no slippage, no fill level and no P&L is
// computed here.
const mailboxes = new Map();

let ws = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let stableTimer = null;


// ------------------------------------------------------------
// BASE44 POSITION SYNC (A + B + C)
// ------------------------------------------------------------

// The current ET weekday and minute-of-day. Used ONLY to choose the sync cadence.
function etClock() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (type) => (parts.find((p) => p.type === type) || {}).value;
  return { weekday: get("weekday"), minutes: Number(get("hour")) * 60 + Number(get("minute")) };
}

// What the app last told us: true when the monitoring endpoint reported the market
// closed (night, weekend, NYSE holiday or after an early close).
let marketClosed = true;

// How long to wait before the next position sync.
function nextSyncDelayMs() {
  const { weekday, minutes } = etClock();
  const tradingDay = weekday !== "Sat" && weekday !== "Sun";
  if (!tradingDay || minutes < TRADING_DAY_FROM_MIN || minutes > TRADING_DAY_TO_MIN) {
    return SYNC_INTERVAL_OFFHOURS_MS; // night or weekend
  }
  return marketClosed ? SYNC_INTERVAL_CLOSED_MS : SYNC_INTERVAL_OPEN_MS;
}

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
  // The app decides whether the market is open; this flag only sets the cadence.
  marketClosed = body?.market_closed === true;
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
    let countA = 0, countB = 0, countC = 0, countAPlus = 0;

    for (const it of items) {
      const symbol = String(it.symbol || "").toUpperCase();
      if (!symbol) continue;
      seenSymbols.add(symbol);

      const system = String(it.system || "").toUpperCase();
      const handler = String(it.handler || "");
      const positionId = String(it.id || "");
      if (!positionId || !handler) continue;

      if (system === "ANEW") countA++;
      else if (system === "B") countB++;
      else if (system === "C") countC++;
      else if (system === "APLUS") countAPlus++;

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

    // Point Massive at the same symbols (in shadow mode it only compares them), and
    // open or close the Finnhub socket to match what is actually open: Finnhub drops
    // a socket that has no subscription within a second or two, so holding one on an
    // empty book produces nothing but a reconnect storm and handshake refusals.
    massiveFeed.setSymbols([...seenSymbols]);
    if (PRICE_FEED !== "massive") {
      if (symbolPositions.size > 0) connectWebSocket();
      else if (ws) {
        try { ws.removeAllListeners(); ws.terminate(); } catch (_) {}
        ws = null;
      }
    }

    // Drop mailboxes whose position is no longer open. A mailbox with a request
    // still in flight is left alone - its own pump finishes and a later sync
    // removes the entry once it is idle - so a position can never briefly have
    // two pumps draining it.
    const activeIds = new Set();
    for (const refs of next.values()) for (const ref of refs) activeIds.add(ref.positionId);
    for (const [id, m] of mailboxes) {
      if (!activeIds.has(id) && !m.inFlight) mailboxes.delete(id);
    }

    console.log(
      `[sync] ${symbolPositions.size} symbol(s), ${items.length} position(s) ` +
      `[NewA=${countA} B=${countB} C=${countC} A+=${countAPlus}] market=${marketClosed ? "closed" : "open"}` +
      (symbolPositions.size ? ": " + Array.from(symbolPositions.keys()).join(", ") : "")
    );

    // Which account (if any) the Render engine is attached to. Deliberately inside
    // the sync's try/catch: an unreadable switchboard leaves the engine idle and
    // Base44 executing, exactly as before.
    await applyEngineSwitches();
  } catch (err) {
    console.error("[sync] error:", err.message);
  }
}


// ------------------------------------------------------------
// ENGINE SWITCHES — who executes which account
//
// The dashboard writes one row per account (EngineSwitch). This reads them, and:
//   • attaches the portfolio book and the candle series for every account whose
//     mode is not "off", so the engine has state and history before its first tick;
//   • re-loads the book on every sync, so a position opened, closed or pressed by
//     Base44 is reflected here before the next price arrives.
//
// Nothing in this section decides anything. It answers "which accounts is the
// engine attached to", and the tick path does the rest.
// ------------------------------------------------------------

async function fetchEngineSwitches() {
  const res = await fetch(SWITCH_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${BASE44_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`getEngineSwitches HTTP ${res.status}`);
  const body = await res.json();
  return Array.isArray(body?.switches) ? body.switches : [];
}

let engineAttached = "";

async function applyEngineSwitches() {
  let switches = [];
  try {
    switches = await fetchEngineSwitches();
  } catch (err) {
    console.error(`[engine] switchboard unavailable (${err.message}) — engine idle, Base44 unaffected`);
    return;
  }

  const attached = switches
    .filter((s) => s && s.mode && String(s.mode) !== "off")
    .map((s) => String(s.system).toUpperCase())
    .filter((s) => positionBook.tableFor(s));

  const key = attached.slice().sort().join(",");
  if (key !== engineAttached) {
    engineAttached = key;
    engineShadow.enable(attached);
    console.log(attached.length
      ? `[engine] attached: ${attached.join(", ")} (shadow = decisions recorded only)`
      : "[engine] attached: none");
  }
  if (!attached.length) return;

  for (const system of attached) {
    try {
      const n = await positionBook.load(system);
      if (key !== engineAttached) break; // superseded by a newer switch read
      console.log(`[engine] ${system} book: ${n} open position(s)`);
    } catch (err) {
      console.error(`[engine] ${system} book load failed: ${err.message}`);
    }
  }

  // Seed only the symbols actually open, and only once per session — this is the
  // only candle fetch the worker ever makes, and it never runs on the tick path.
  try {
    await engineShadow.primeSymbols([...symbolPositions.keys()]);
  } catch (err) {
    console.error(`[engine] candle seed: ${err.message}`);
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

// Send ONE price to ONE position's handler and log the outcome. pumpMailbox()
// below is the only caller and guarantees one request at a time per position,
// so no in-flight guard is needed here and two requests for the same position
// can never overlap.
//
// This function never throws - every failure is logged and returns - so a price
// waiting in the mailbox can never be stranded behind a failed request.
async function forwardTick(ref, symbol, price) {
  // Abort the request if the handler never responds, so one stalled request
  // cannot stop this position's mailbox from draining. The finally block below
  // always runs.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TICK_TIMEOUT_MS);

  // SHADOW DECISION. When this account is attached to the Render engine, the same
  // price and the same book are put through the portable engine BEFORE the price is
  // forwarded, so its verdict can be compared with Base44's answer to the identical
  // tick. Writes nothing. Returns null — at no cost — when the account is not
  // attached, which is every account until the switch says otherwise.
  const verdict = engineShadow.decide(ref, symbol, price);

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
      signal: controller.signal,
    });

    let body = null;
    try { body = await res.json(); } catch (_) {}

    // Record the pair: the engine's verdict and Base44's, on the same price.
    engineShadow.record(ref, symbol, price, verdict, body);

    // Base44 is the writer in shadow mode, so its action is the freshest truth
    // about this position. Re-read it once after Base44 changes something, so the
    // engine's book can never sit up to 15 s stale and turn a real agreement into a
    // false disagreement. One read per ACTION, never per tick.
    if (engineShadow.enabled() && body && (body.applied || body.closed)) {
      positionBook.reloadOne(ref.system, ref.positionId).catch(() => {});
    }

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
    if (err.name === "AbortError") {
      console.error(`[${ref.system}] ${symbol} -> ${ref.handler}: tick timed out after ${TICK_TIMEOUT_MS}ms (mailbox continues with the latest pending price)`);
    } else {
      console.error(`[${ref.system}] ${symbol} -> ${ref.handler}: ${err.message}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

// Each position's own one-slot mailbox (created on first use).
function mailboxFor(positionId) {
  let m = mailboxes.get(positionId);
  if (!m) {
    m = { inFlight: false, pending: null };
    mailboxes.set(positionId, m);
  }
  return m;
}

// Hand one price to one position. If that position has nothing in flight the
// price starts processing immediately; otherwise it takes the single pending
// slot, replacing whatever was waiting there (latest price wins). The replaced
// price is not lost work - it is an older price for the same position, and the
// newer one carries everything the handler needs to decide.
function deliverTick(ref, symbol, price) {
  const m = mailboxFor(ref.positionId);

  if (m.inFlight) {
    m.pending = { ref, symbol, price };
    return;
  }

  pumpMailbox(m, { ref, symbol, price }).catch((err) => {
    console.error(`[mailbox] ${ref.system} ${symbol}: ${err?.message || err}`);
  });
}

// Drain one position's mailbox: send the newest price, then, as soon as that
// request settles, send the price that arrived while it was in flight. The slot
// is read and cleared with no await in between, so a tick can never slip in
// between the last read and the inFlight reset below.
async function pumpMailbox(m, first) {
  m.inFlight = true;

  let next = first;

  try {
    while (next) {
      await forwardTick(next.ref, next.symbol, next.price);
      next = m.pending;
      m.pending = null;
    }
  } finally {
    m.inFlight = false;
  }
}

function routeTick(symbol, price) {
  lastTick.set(symbol, Date.now());

  // Shadow mode: remember what Finnhub is quoting so Massive's prices can be
  // compared with it on the same symbol. Never affects the tick itself.
  if (PRICE_FEED === "massive-shadow") massiveFeed.noteFinnhubPrice(symbol, price);

  const refs = symbolPositions.get(symbol);
  if (!refs || refs.length === 0) return;

  // A, B, C and A+ are independent: every position gets the tick through its own
  // mailbox, each with its own in-flight request, so a slow handler in one system
  // never delays another system's price.
  for (const ref of refs) deliverTick(ref, symbol, price);
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
  // Massive owns the feed: keep Finnhub closed rather than duplicating ticks.
  if (PRICE_FEED === "massive") return;
  // Nothing open, nothing to subscribe to: Finnhub closes an unsubscribed socket in
  // about two seconds, and the retries that follow are what produced the 429 storm.
  // The next sync opens the socket as soon as a position exists.
  if (symbolPositions.size === 0) return;
  // ONE socket per process. Two sockets from the same worker fight over the same
  // stream: Finnhub gives it to whichever connected last and refuses the other with
  // 429, so each side's retry closes the other — a handshake ping-pong. A socket
  // that is still live is therefore never replaced, and a finished one is retired
  // before its successor opens.
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  if (ws) {
    try { ws.removeAllListeners(); ws.terminate(); } catch (_) {}
    ws = null;
  }

  console.log("Connecting to Finnhub WebSocket...");

  const socket = new WebSocket(FINNHUB_WS_URL);
  ws = socket;

  // Every handler below belongs to THIS socket. Once a socket has been replaced its
  // events are ignored, so a late 'close' can never schedule a retry for a socket
  // that is no longer the current one.
  socket.on("open", () => {
    if (ws !== socket) return;

    console.log("Connected to Finnhub WebSocket");

    // NOT reset here: the backoff resets only after the connection has held for
    // CONNECTION_STABLE_MS, so being accepted and immediately taken over cannot
    // re-arm the 1-second retry.
    clearTimeout(stableTimer);
    stableTimer = setTimeout(() => {
      if (ws === socket && socket.readyState === WebSocket.OPEN) {
        reconnectAttempts = 0;
        console.log(`[ws] connection stable for ${CONNECTION_STABLE_MS / 1000}s — reconnect backoff reset`);
      }
    }, CONNECTION_STABLE_MS);

    // Re-subscribe everything after reconnect.
    for (const symbol of symbolPositions.keys()) {
      wsSend({ type: "subscribe", symbol });
    }
  });

  socket.on("message", (raw) => {
    if (ws !== socket) return;

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

  socket.on("close", () => {
    if (ws !== socket) return;    // a retired socket must never drive the retry loop
    if (socket.finished) return;  // already handled by the error path

    console.log("Finnhub WebSocket disconnected");
    scheduleReconnect(false);
  });

  socket.on("error", (err) => {
    if (ws !== socket) return;

    const message = String(err?.message || "");
    // HTTP 429 on the handshake = Finnhub refusing a new connection because one
    // already holds the stream. Treating it like an ordinary drop is what floods
    // the handshake endpoint.
    const rateLimited = /\b429\b/.test(message);
    console.error("[ws] error:", message);

    // This socket is finished either way: retire it so the retry opens one clean
    // connection instead of racing this one for the stream.
    socket.finished = true;
    clearTimeout(stableTimer);
    try { socket.terminate(); } catch (_) {}

    scheduleReconnect(rateLimited);
  });
}


// ------------------------------------------------------------
// RECONNECT
// ------------------------------------------------------------

function scheduleReconnect(rateLimited = false) {
  if (reconnectTimer) return;

  reconnectAttempts += 1;

  // A rate-limited handshake gets the fixed long wait; everything else keeps the
  // 1s, 2s, 4s … ladder capped at RECONNECT_MAX_MS.
  const delay = rateLimited
    ? RECONNECT_RATE_LIMIT_MS
    : Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts - 1));

  console.log(
    `[ws] reconnecting in ${delay} ms (attempt ${reconnectAttempts})` +
    (rateLimited ? " — handshake refused (429)" : "")
  );

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
  // Nothing is open (off-hours, weekend or holiday) — there is nothing to poll.
  if (symbolPositions.size === 0) return;

  const now = Date.now();

  for (const symbol of symbolPositions.keys()) {
    const last = lastTick.get(symbol) || 0;

    if (now - last < QUIET_TICK_MS) continue;

    try {
      // In Massive mode the fallback is Massive's own snapshot, which has no
      // per-minute ceiling; every other mode keeps Finnhub's quote exactly as before.
      let price = null;

      if (PRICE_FEED === "massive") {
        price = await massiveFeed.snapshotPrice(symbol);
      } else {
        const res = await fetch(
          `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FINNHUB_API_KEY}`
        );

        if (!res.ok) continue;

        const q = await res.json();
        price = numberOrNull(q && q.c);
      }

      if (price && price > 0) {
        routeTick(symbol, price);
      }
    } catch (err) {
      console.error(`[quote] ${symbol} error:`, err.message);
    }
  }
}


// ------------------------------------------------------------
// STARTUP DATABASE VERIFICATION (READ-ONLY)
//
// Proves this service reaches the same Cloud SQL database Base44 trades on.
// It calls ONLY two whitelisted bridge operations - `ping_timed` and
// `countAllPositionsInTable` - so it cannot create, update or delete a record,
// and it takes no part in tick routing or in any trading rule. C, D and E stay
// halted: nothing here opens, manages or closes a position.
//
// The bridge accepts no arbitrary SQL by design, so it exposes no operation
// that returns the database NAME. Identity is therefore proven by fingerprint:
// the live database must answer with these tables and these row counts.
// ------------------------------------------------------------

const VERIFY_TABLES = ["positions_anew", "positions_b", "positions_c", "positions_d", "positions_e"];

async function bridgeRead(operation, params = {}) {
  const t0 = Date.now();
  const res = await fetch(`${BRIDGE_URL}/db`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${BRIDGE_API_KEY}` },
    body: JSON.stringify({ operation, params }),
    signal: AbortSignal.timeout(10000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    throw new Error(`${operation}: HTTP ${res.status} ${body.error || "no error detail"}`);
  }
  return { result: body.result, ms: Date.now() - t0 };
}

async function verifyDatabase() {
  if (!BRIDGE_URL || !BRIDGE_API_KEY) {
    console.log(
      "[db] verification skipped - BRIDGE_URL / BRIDGE_API_KEY are not set on this service (tick routing unaffected)"
    );
    return;
  }
  try {
    const health = await fetch(`${BRIDGE_URL}/health`, { signal: AbortSignal.timeout(10000) })
      .then((r) => r.json())
      .catch(() => null);
    console.log(
      `[db] bridge ${BRIDGE_URL.replace(/^https?:\/\//, "")} health=${health && health.ok ? "ok" : "unavailable"}`
    );

    const ping = await bridgeRead("ping_timed");
    const p = ping.result || {};
    console.log(
      `[db] ping ok - round trip ${ping.ms} ms, Cloud SQL ${p.elapsed_ms} ms, server time ${p.server_time}`
    );

    const counts = [];
    for (const table of VERIFY_TABLES) {
      const c = await bridgeRead("countAllPositionsInTable", { table });
      counts.push(`${table}=${c.result}`);
    }
    console.log(`[db] rows  ${counts.join("  ")}`);
    console.log(
      "[db] verdict: reached the live Cloud SQL database - same instance and tables Base44 trades on (read-only, nothing written)"
    );
  } catch (err) {
    console.error(`[db] verification FAILED - ${err.message}`);
  }
}


// ------------------------------------------------------------
// START
// ------------------------------------------------------------

async function start() {
  console.log("Starting DART NewA/B/C/A+ real-time tick router (paper, USD)...");

  // Graceful stop. The price providers allow ONE stream per account, so this process
  // must release its sockets before it exits — otherwise a redeploy's old instance
  // holds the stream while the new one opens, and both get closed as duplicates.
  process.on("SIGTERM", () => {
    console.log("[worker] SIGTERM — releasing price feeds before exit");
    try { massiveFeed.shutdown(); } catch (_) {}
    try { if (ws) { ws.removeAllListeners(); ws.terminate(); } } catch (_) {}
    process.exit(0);
  });

  // Resolve the bridge credentials FIRST, so the verification below and the engine's
  // book reads both see a configured bridge. One request, before any tick.
  await resolveBridgeConfig();
  await resolveMassiveKey();

  // Decide the price feed now that every key is known.
  PRICE_FEED = resolveFeedMode();

  // Read-only database identity check. Deliberately NOT awaited: it must never
  // delay the first tick or the position sync, and it can never throw.
  verifyDatabase();

  // Price feed. Massive is prepared in every mode; in shadow it only compares.
  massiveFeed.configure(MASSIVE_API_KEY);
  massiveFeed.enable(
    PRICE_FEED === "massive" ? "live" : PRICE_FEED === "massive-shadow" ? "shadow" : "off",
    routeTick
  );
  const massiveStarted = massiveFeed.start();
  console.log(
    `[feed] price feed = ${PRICE_FEED}` +
    (massiveStarted ? " (massive stream up)" : " (massive idle)") +
    " — trading rules unchanged"
  );

  // Discover open positions across A, B and C.
  await syncWithBase44();

  // Start live Finnhub feed (skipped when Massive owns the ticks).
  connectWebSocket();

  // Discover newly opened / replacement positions, at a cadence that follows the
  // market: 15 s while the session is live, once a minute while the app reports it
  // closed inside the trading day, once every five minutes at night and on weekends.
  function scheduleSync() {
    setTimeout(async () => {
      await syncWithBase44();
      scheduleSync();
    }, nextSyncDelayMs());
  }
  scheduleSync();

  // Catch events on quiet symbols.
  setInterval(pollQuietSymbols, POLL_LOOP_MS);

  // Drain the shadow-run rows. Writes only to the ShadowTick entity; no-ops while
  // nothing is attached.
  engineShadow.startFlusher();
}

start().catch((err) => {
  console.error("Worker startup failed:", err);
  process.exit(1);
});