// worker.js - Render tick-router for DART A / B / C live forward-test (PAPER).
//
// Finnhub supplies live WebSocket ticks (with a REST /quote fallback for
// quiet symbols). Base44 owns ALL trading math - dartLiveNewA, dartLiveB and
// dartLiveC each compute stops, presses, exits and the Vector 65 from the live
// tick P&L. This worker discovers open positions across the three permanent
// accounts from getMonitoringStateAll, subscribes to each unique symbol once,
// and routes every tick to the handler specified for each position.
//
// The same symbol can be open in A, B and C at the same time; each tick for that
// symbol is forwarded independently to each system's handler, through that
// position's own mailbox. No duplicate quote requests — each unique symbol is
// subscribed once.
//
// DART D is wired onto this engine ahead of its activation (2026-11-08): its positions
// are served like the others, its switchboard row says render / live, and it is still
// HALTED — so each of its ticks is decided and the verdict is "halted", which writes
// nothing. DART E is halted and served to nobody.
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
import * as engineLive from "./engineLive.js";
import * as positionBook from "./positionBook.js";
import * as dBudget from "./dBudget.js";
import { applyTick as recordBar, configure as configureCandles } from "./candleService.js";
import { configure as configureBridge } from "./bridge.js";
import * as massiveFeed from "./massiveFeed.js";
import * as standby from "./feedStandby.js";
import * as tradeConditions from "./tradeConditions.js";
import { runSessionClose, CLOSE_SWEEP_INTERVAL_MS } from "./closeSweep.js";
import { makeClosePriceResolver, finnhubQuote as quoteFromFinnhub, CLOSE_MAX_PRICE_AGE_MS } from "./closeQuote.js";
import { verifyDatabase } from "./dbVerify.js";
import { noteLargeMove, summary as largeMovesSummary, forget as forgetLargeMoves } from "./largeMoves.js";
import { HALTED_SYSTEMS, isSystemHalted } from "./tickRules.js";

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
//   massive        — Massive routes every tick, and the Finnhub socket stays connected
//                    as a WARM STANDBY: a symbol only takes Finnhub prices after 15 s
//                    without a Massive print and hands back on Massive's next one
//                    (feedStandby.js). Both feeds use the same trading rules.
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

// symbol -> the last price routeTick accepted. Handed to largeMoves.js to REPORT a large move;
// never a reason to refuse one.
const lastPrice = new Map();

// A fallback quote may not describe an older session. AGE ONLY — see LARGE_MOVE_DEVIATION.
const FALLBACK_MAX_QUOTE_AGE_MS = 60000;

// LARGE MOVES ARE REPORTED, NEVER REFUSED (2026-11-09). A percentage band cannot tell a bad
// price from a good one — a halt resume, an opening gap and a news spike are genuine prints —
// and because the reference price only advanced on an ACCEPTED print, one rejection refused
// every later price too: no stop, no trail, no 16:00 close for that symbol. Magnitude is now
// diagnostic only, and it lives in largeMoves.js, whose every line describes a price that WAS
// used. Notice it is never asked here whether to accept anything.

// A STREAM print carries the venue's own stamp, and that stamp is the only proof the
// print describes the present. Measured transit is tens of milliseconds, so this is a
// wide margin against clock skew and still far tighter than the 60 s the quote paths use.
const STREAM_MAX_PRINT_AGE_MS = 10000;

// symbol -> how many stream prints were refused, so a replay burst cannot flood the log.
const streamRejected = new Map();

function rejectStreamPrint(symbol, price, reason) {
  const seen = (streamRejected.get(symbol) || 0) + 1;
  streamRejected.set(symbol, seen);
  if (seen <= 3 || seen % 100 === 0) {
    console.warn(
      `[stream] ${symbol} print ${price} REJECTED — ${reason}` +
      (seen > 3 ? ` (${seen} refused on this symbol)` : "")
    );
  }
}


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
  // DART D's buying power for today travels on this same response, so sizing its press
  // costs no extra request. A payload without it (closed market, or the day's row not
  // yet fixed) clears the cached figure rather than leaving a stale one in place.
  dBudget.setFromMonitoring(body);
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
    let countA = 0, countB = 0, countC = 0, countD = 0;

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
      else if (system === "D") countD++;

      if (!next.has(symbol)) next.set(symbol, []);
      next.get(symbol).push({ positionId, handler, system });
    }

    // Subscribe to newly seen symbols, unsubscribe from dropped ones.
    const prevSymbols = new Set(symbolPositions.keys());
    for (const symbol of seenSymbols) {
      if (!prevSymbols.has(symbol)) {
        // A symbol that was not open a moment ago starts with no reference price, so its
        // first print establishes the book instead of being judged against a price left
        // over from an earlier session (which an overnight gap would otherwise lock out).
        lastPrice.delete(symbol);
        forgetLargeMoves(symbol);
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
    // Finnhub: the router in finnhub mode, the warm standby in massive mode. Either way
    // it holds ONE socket for every open symbol; in massive mode an empty book keeps the
    // standby socket alive on SPY instead of closing it.
    if (symbolPositions.size > 0 || PRICE_FEED === "massive") {
      connectWebSocket();
      if (PRICE_FEED === "massive" && symbolPositions.size === 0) {
        wsSend({ type: "subscribe", symbol: "SPY" });
      }
    } else if (ws) {
      try { ws.removeAllListeners(); ws.terminate(); } catch (_) {}
      ws = null;
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
      `[A=${countA} B=${countB} C=${countC} D=${countD}] market=${marketClosed ? "closed" : "open"}` +
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

  // Hand the same rows to the live writer. It writes ONLY for an account whose
  // engine is 'render' AND whose mode is 'live'; every other row leaves it refusing
  // every verdict, so deploying it changes nothing until the switchboard says so.
  engineLive.setModes(switches);

  const key = attached.slice().sort().join(",");
  if (key !== engineAttached) {
    engineAttached = key;
    engineShadow.enable(attached);
    const live = engineLive.liveSystems();
    console.log(attached.length
      ? `[engine] attached: ${attached
          .map((s) => {
            const row = switches.find((x) => String(x.system).toUpperCase() === s) || {};
            return `${s}(${String(row.engine || "base44")}/${String(row.mode || "off")})`;
          })
          .join(", ")} — live writers: ${live.length ? live.join(", ") : "none"}`
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

  // Seed the symbols actually open plus SPY — once per session, never on the tick
  // path. SPY is included because the protective stop's market leg is scored on the
  // SPY series, so without it that half of the test has no bars at all.
  try {
    await engineShadow.primeSymbols([...symbolPositions.keys(), "SPY"]);
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
  // THE ENGINE DECIDES FIRST, for every attached account, from the same price and the
  // same book. Returns null — at no cost — when the account is not attached.
  const verdict = engineShadow.decide(ref, symbol, price);

  // LIVE: Render is the executor for this account. The verdict is written through the
  // guarded position update and the tick is NEVER forwarded — that is the whole
  // migration, and the single-writer guarantee from the tick path's side. Base44's
  // handler for this account already returns a no-op once its engine row says render.
  if (engineLive.ownsWrites(ref.system)) {
    const result = await engineLive.apply(ref, verdict);
    if (result?.applied && result.reason !== "hold_state") {
      console.log(
        `[live] ${ref.system} ${symbol}: ${verdict.action}${verdict.event ? " " + verdict.event : ""}` +
        (verdict.pl_raw != null ? ` pl=${fmt(verdict.pl_raw)}` : "") +
        (verdict.exit_price != null ? ` @${fmt(verdict.exit_price)}` : "")
      );
    } else if (
      result &&
      result.reason !== "hold" &&
      result.reason !== "hold_state" &&
      result.reason !== "halted" &&   // DART D until it is turned on: decided, never written
      result.reason !== "not_owner"
    ) {
      console.error(`[live] ${ref.system} ${symbol}: ${verdict.action} not written (${result.reason})`);
    }
    return;
  }

  // Abort the request if the handler never responds, so one stalled request
  // cannot stop this position's mailbox from draining. The finally block below
  // always runs.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TICK_TIMEOUT_MS);

  // SHADOW: Base44 is still the writer, so the price is forwarded and its answer is
  // recorded beside the engine's verdict for the identical tick.
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

// exchangeMs is the venue's own stamp on this print, when the caller has one
// (Finnhub's socket tick carries `t`). It is used ONLY by the shadow comparison's
// lag measurement and never reaches a trading rule or a stored price.
//
// `source` names the feed that produced the price ("massive" or "finnhub"). It selects
// nothing but the standby bookkeeping — the same price takes the same path through
// every rule either way.
function routeTick(symbol, price, exchangeMs, source = "finnhub") {
  // Report a large move before the anchor moves, so the line carries both prices.
  noteLargeMove(symbol, price, source);
  lastTick.set(symbol, Date.now());
  lastPrice.set(symbol, price);
  // EVERY tick feeds the worker's own 1-minute series, whether or not a position is
  // open in it. SPY is subscribed permanently, so the market leg of the protective
  // stop gets real bars from the open instead of only an archived tail — before this
  // the SPY series was never built at all, and the market test could not be scored.
  recordBar(symbol, price);

  // Shadow mode: remember what Finnhub is quoting so Massive's prices can be
  // compared with it on the same symbol. Never affects the tick itself.
  // The print's own stamp travels with it, so the comparison can measure transit on
  // both feeds instead of only on Massive's. A REST fallback price carries no trade
  // stamp and is counted as unstamped rather than timed.
  if (PRICE_FEED === "massive-shadow") massiveFeed.noteFinnhubPrice(symbol, price, exchangeMs);

  const refs = symbolPositions.get(symbol);
  if (!refs || refs.length === 0) return;

  // A, B and C are independent: every position gets the tick through its own
  // mailbox, each with its own in-flight request, so a slow handler in one system
  // never delays another system's price.
  for (const ref of refs) deliverTick(ref, symbol, price);
}


// ------------------------------------------------------------
// MASSIVE PRIMARY, FINNHUB STANDBY
//
// In massive mode every accepted Massive price is routed and marks its symbol current.
// Finnhub stays connected as a warm standby: its print for a symbol is used only after
// 15 s without a Massive print, and the symbol hands back on Massive's next print. Each
// takeover is logged with its symbol, its start time and how long the standby served it,
// so how often the backup is needed is visible in the log.
// ------------------------------------------------------------

// What the Finnhub socket subscribes to: every open symbol, plus SPY on an empty book in
// massive mode so the standby socket has something holding it open.
function standbySubscriptions() {
  const symbols = [...symbolPositions.keys()];
  if (PRICE_FEED === "massive" && symbols.length === 0) symbols.push("SPY");
  return symbols;
}

// One Massive STREAM print. The venue's stamp travels with it, and it is the only proof
// the print describes the present — so it is required.
//
// GUARD (cut 2026-11-09, re-cut the same evening). Two questions, in this order:
//
//   1. WHAT IS THIS PRINT? tradeConditions.js answers from the frame's own fields: the
//      sale conditions the SIP stamped on it, and the gap between when it executed (pt)
//      and when it was taped (t). This is the decisive test, and it is the one the 14:51
//      flush fails — every print that closed a position carried condition 13, "Extended
//      Hours (Sold Out Of Sequence)", for a trade executed 11-15 hours earlier.
//
//   2. HOW OLD IS IT? A print older than STREAM_MAX_PRINT_AGE_MS describes a finished tape
//      and is not a price.
//
// HOW FAR THE PRICE MOVED IS NOT A QUESTION HERE ANY MORE (2026-11-09). Magnitude decided
// nothing until it had already caused the damage it was meant to prevent: because the
// reference price only advanced on an ACCEPTED print, one rejected print refused every
// later one too. Size is now reported by noteLargeMove and never refused. Anything refused
// above is dropped without touching the book, and the next print decides.
function onMassivePrice(symbol, price, exchangeMs, meta = {}) {
  // 1. Eligibility, from what the tape says this print is.
  const eligibility = tradeConditions.assess({
    conditions: meta.conditions,
    participantMs: meta.participantMs,
    tapeMs: exchangeMs,
  });
  if (!eligibility.eligible) {
    rejectStreamPrint(symbol, price, eligibility.reason);
    return;
  }

  // 2. The print must describe the present. FRESHNESS IS AGE ONLY — it takes no price, so a
  //    halt resume 20 % away, an opening gap or a news spike is a price whatever its size.
  const freshness = tradeConditions.assessFreshness({
    stampMs: exchangeMs,
    maxAgeMs: STREAM_MAX_PRINT_AGE_MS,
  });
  if (!freshness.ok) {
    rejectStreamPrint(symbol, price, `print ${freshness.reason}`);
    return;
  }

  adoptMassivePrice(symbol, price, Number(exchangeMs));
}

// A Massive price that has ALREADY been validated — by the stream guard above, or by the
// snapshot fallback's own age check. Books it as current (ending any Finnhub takeover) and
// routes it exactly as before. Kept separate so the stamp rule cannot reject the one path
// that was already safe. No magnitude test exists on either side.
function adoptMassivePrice(symbol, price, exchangeMs = null) {
  const ended = standby.noteMassive(symbol, price);
  if (ended) {
    console.log(
      `[standby] ${symbol} HANDED BACK to Massive at ${fmt(price)} — ` +
      `Finnhub served it ${(ended.durationMs / 1000).toFixed(1)}s from ` +
      `${new Date(ended.startedAt).toISOString()} (${ended.prints} print${ended.prints === 1 ? "" : "s"})`
    );
  }
  routeTick(symbol, price, exchangeMs, "massive");
}

// May this Finnhub print route its symbol? Only when Massive is stale for it, the print
// describes the present (60 s), and it does not reprice the book (3%).
function standbyAdmits(symbol, price, exchangeMs) {
  const verdict = standby.admitFinnhub(symbol, price, { exchangeMs });
  if (!verdict.use) {
    if (verdict.reason !== "massive_current") {
      console.warn(
        `[standby] ${symbol} Finnhub print ${price} REJECTED — ${verdict.reason}` +
        (verdict.printAgeMs ? ` (${Math.round(verdict.printAgeMs / 1000)}s old)` : "")
      );
    }
    return false;
  }
  if (verdict.started) {
    console.log(
      `[standby] ${symbol} TAKEOVER at ${new Date().toISOString()} — no Massive print for ` +
      `${(verdict.massiveAgeMs / 1000).toFixed(1)}s, routing Finnhub ${price}`
    );
  }
  return true;
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
  // In finnhub mode this socket routes every tick. In massive mode it is the WARM
  // STANDBY: one socket with every open symbol subscribed, its prices used only for a
  // symbol Massive has gone quiet on. The one-socket rule is identical in both modes.
  const standbyOnly = PRICE_FEED === "massive";
  // Nothing open and no standby to hold: Finnhub closes an unsubscribed socket in about
  // two seconds, and the retries that follow are what produced the 429 storm. The next
  // sync opens the socket as soon as a position exists.
  if (!standbyOnly && symbolPositions.size === 0) return;
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

    console.log(
      standbyOnly
        ? `Finnhub standby connected — ${standbySubscriptions().length} symbol(s) subscribed (Massive is the primary feed)`
        : "Connected to Finnhub WebSocket"
    );

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

    // Re-subscribe everything after reconnect (the standby keeps SPY on an empty book).
    for (const symbol of standbyOnly ? standbySubscriptions() : symbolPositions.keys()) {
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
          // `trade.t` is Finnhub's own epoch-ms stamp for this print.
          const stamp = Number(trade.t);
          // Massive mode: Finnhub only covers a symbol Massive has gone quiet on.
          if (PRICE_FEED === "massive" && !standbyAdmits(symbol, price, stamp)) continue;
          routeTick(symbol, price, stamp);
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
      // If Massive cannot answer at all, Finnhub's quote is the standby's last resort and
      // goes through the same standby gate (15 s silence, 60 s print age, no magnitude).
      const massivePrimary = PRICE_FEED === "massive";
      let price = null;
      let exchangeMs = null;
      let fromFinnhub = false;

      if (massivePrimary) price = await massiveFeed.snapshotPrice(symbol);

      if (!massivePrimary || price == null) {
        const res = await fetch(
          `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${FINNHUB_API_KEY}`
        );

        if (!res.ok) continue;

        const q = await res.json();
        // q.t is when the quote was last updated (epoch seconds). A quote older than the
        // limit describes a finished session — its `c` is that session's close, and routing
        // it would value an open position off a dead tape. AGE ONLY, never magnitude.
        const quoteTs = numberOrNull(q && q.t);
        const quoteFresh = tradeConditions.assessFreshness({
          stampMs: quoteTs ? quoteTs * 1000 : null,
          maxAgeMs: FALLBACK_MAX_QUOTE_AGE_MS,
        });
        if (!quoteFresh.ok) {
          console.warn(
            `[quote] ${symbol} REJECTED — quote ${quoteFresh.reason} ` +
            `(limit ${FALLBACK_MAX_QUOTE_AGE_MS / 1000}s)`
          );
          continue;
        }
        price = numberOrNull(q && q.c);
        exchangeMs = quoteTs ? quoteTs * 1000 : null;
        fromFinnhub = massivePrimary;
      }

      if (fromFinnhub) {
        if (price && price > 0 && standbyAdmits(symbol, price, exchangeMs)) {
          routeTick(symbol, price, exchangeMs, "finnhub");
        }
        continue;
      }

      if (price && price > 0) {
        // NO MAGNITUDE TEST. This path exists to recover a symbol whose stream went quiet,
        // and a quiet symbol is often one that halted and resumed somewhere else entirely —
        // a band here would refuse the very resume it was built to carry. Age was checked
        // above; any large move is reported by noteLargeMove, never refused.
        if (massivePrimary) adoptMassivePrice(symbol, price);
        else routeTick(symbol, price);
      }
    } catch (err) {
      console.error(`[quote] ${symbol} error:`, err.message);
    }
  }
}


// ------------------------------------------------------------
// THE PRICE THE CLOSE IS EXECUTED AT
//
// The sweep must close at a price that describes the market as of the close. The router keeps
// the last accepted price AND when it was accepted, so the close can judge its age instead of
// trusting it: a symbol that stopped printing an hour ago has an hour-old price.
// ------------------------------------------------------------

// Built from the router's own maps so the close can judge a price's AGE rather than trusting
// it. The policy (ask the market first, label and count a stale fallback) is in closeQuote.js.
const closePriceResolver = makeClosePriceResolver({
  lastPrice,
  lastTick,
  fetchSnapshot: (symbol) => (PRICE_FEED === "massive" ? massiveFeed.snapshotPrice(symbol) : null),
  fetchQuote: (symbol) => quoteFromFinnhub(symbol, FINNHUB_API_KEY),
});

// ------------------------------------------------------------
// STARTUP DATABASE VERIFICATION (READ-ONLY) — moved to dbVerify.js (2026-11-09).
// The same two whitelisted bridge reads, the same log lines, no trading effect.


// ------------------------------------------------------------
// START
// ------------------------------------------------------------

async function start() {
  // The halt list this process actually runs on, printed at startup, so a deploy can
  // be checked against it instead of assumed: halted accounts decide nothing, and
  // every other account is live here.
  console.log(
    `Starting DART real-time tick router (paper, USD) — live: ${["ANEW", "B", "C", "D"]
      .filter((s) => !isSystemHalted(s))
      .join(", ")} | halted: ${HALTED_SYSTEMS.join(", ") || "none"}`
  );

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

  // Hand the same market-data key to the candle series so it can seed the full
  // session from the provider rather than the afternoon-only archive.
  configureCandles(MASSIVE_API_KEY);

  // Read-only database identity check. Deliberately NOT awaited: it must never
  // delay the first tick or the position sync, and it can never throw.
  verifyDatabase({ bridgeUrl: BRIDGE_URL, bridgeKey: BRIDGE_API_KEY });

  // Price feed. Massive is prepared in every mode; in shadow it only compares.
  massiveFeed.configure(MASSIVE_API_KEY);
  massiveFeed.enable(
    PRICE_FEED === "massive" ? "live" : PRICE_FEED === "massive-shadow" ? "shadow" : "off",
    onMassivePrice
  );
  const massiveStarted = massiveFeed.start();
  console.log(
    `[feed] price feed = ${PRICE_FEED}` +
    (massiveStarted ? " (massive stream up)" : " (massive idle)") +
    " — trading rules unchanged"
  );
  if (PRICE_FEED === "massive") {
    console.log(
      "[feed] Finnhub standby: armed — one standby socket with every open symbol subscribed; " +
      `a symbol only takes Finnhub prices after ${standby.STALE_AFTER_MS / 1000}s without a Massive print ` +
      `(${standby.MAX_PRINT_AGE_MS / 1000}s print age, no magnitude filter), ` +
      "and hands back on Massive's next print; every takeover is logged"
    );
  }

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

  // THE SESSION END DOES NOT WAIT FOR A TRADE (2026-11-09). Every exit — the 16:00 close
  // included — is decided inside decideTick, which runs only when a price arrives, and for a
  // Render-owned account nothing else may write. A symbol that stops printing therefore has
  // no closing procedure at all, so this sweep closes any position its session has ended for
  // at the last price this process holds, through the same guarded write a tick uses.
  // Printed once at startup so a deploy can be checked against what it actually runs.
  console.log(
    `[close] session sweep every ${CLOSE_SWEEP_INTERVAL_MS / 1000}s — close price FETCHED at the close ` +
    `(max age ${CLOSE_MAX_PRICE_AGE_MS / 1000}s); with no current price the fill is labelled stale, never silent`
  );
  setInterval(() => {
    runSessionClose({
      systems: engineLive.liveSystems(),
      ids: positionBook.ids,
      get: positionBook.get,
      apply: (ref, verdict) => engineLive.apply(ref, verdict),
      reload: positionBook.reloadOne,
      // The close price is FETCHED at the close, not remembered from whenever the symbol last
      // printed (closeQuote.js). A fill at an hour-old price never happened in the market.
      resolvePrice: closePriceResolver,
      priceFor: (symbol) => lastPrice.get(symbol) ?? null,
    }).catch((err) => console.error(`[close] sweep failed: ${err?.message || err}`));
  }, CLOSE_SWEEP_INTERVAL_MS);

  // How often the standby had to cover for Massive, and what large moves were seen, in one
  // line every five minutes. Large moves are REPORTED ONLY — every one of them was used.
  setInterval(() => {
    const moves = largeMovesSummary();
    if (moves.total) {
      console.log(`[move] ${moves.total} large move(s) across ${moves.symbols} symbol(s) this process — all used, none refused`);
    }
    if (PRICE_FEED !== "massive") return;
    const s = standby.summary();
    console.log(
      `[standby] takeovers=${s.takeovers} active=${s.activeCount} finnhub_prints=${s.finnhubPrints}` +
      ` total=${(s.totalTakeoverMs / 1000).toFixed(1)}s longest=${(s.longestMs / 1000).toFixed(1)}s` +
      (s.activeCount
        ? ` (${s.active.map((a) => `${a.symbol} ${Math.round(a.ageMs / 1000)}s`).join(", ")})`
        : "") +
      (s.last ? ` | last ${s.last.symbol} ${(s.last.durationMs / 1000).toFixed(1)}s` : "")
    );
  }, 300000);

  // Drain the shadow-run rows. Writes only to the ShadowTick entity; no-ops while
  // nothing is attached.
  engineShadow.startFlusher();
}

start().catch((err) => {
  console.error("Worker startup failed:", err);
  process.exit(1);
});