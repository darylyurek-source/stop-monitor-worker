// worker.js — Render stop-monitor-worker for Dart A live forward-test (PAPER).
//
// Finnhub supplies live WebSocket ticks.
// Base44 owns ALL trading math.
// This worker only watches the stored trigger prices and sends events to Base44.
//
// Real-time events:
//   stop      = -$1,700
//   press1    = +$200
//   press2    = +$400
//   exit_900  = +$900
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

const FINNHUB_WS_URL =
  "wss://ws.finnhub.io?token=" + FINNHUB_API_KEY;

const EVENT_ENDPOINT =
  `${BASE44_APP_URL}/api/functions/realtimeStopClose`;

// IMPORTANT:
// Preserve the exact Position endpoint already proven to work in this worker.
const POSITION_ENDPOINT =
  `${BASE44_APP_URL}/functions/getMonitoringState`;

// Check Base44 frequently so newly opened positions begin real-time monitoring quickly.
const SYNC_INTERVAL_MS = 15000;

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

// symbol -> current Base44 Position state
const positions = new Map();

// Prevent simultaneous event requests for the same Position.
const busy = new Set();

let ws = null;
let reconnectTimer = null;
let reconnecftAttempts = 0;


// ------------------------------------------------------------
// BASE44 POSITION SYNC
// ------------------------------------------------------------

async function fetchOpenPositions() {
 const res = await fetch(POSITION_ENDPOINT, {
    headers: {
      Authorization: `Bearer ${BASE44_API_KEY}`,
      "Content-Type": "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(
      `Base44 positions HTTP ${res.status} ${res.statusText}`
    );
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
    const seen = new Set();

    for (const it of items) {
      const symbol = String(it.symbol || "").toUpperCase();

      if (!symbol) continue;

      seen.add(symbol);

      const state = {
        id: it.id,
        symbol,
        side: String(it.side || "").toLowerCase(),
        status: it.status,

        shares: it.shares,
        weighted_avg_cost: it.weighted_avg_cost,

        pressed_1r: !!it.pressed_1r,
        pressed_2r: !!it.pressed_2r,

        current_stop: numberOrNull(it.current_stop),

        trigger_press1_price:
          numberOrNull(it.trigger_press1_price),

        trigger_press2_price:
          numberOrNull(it.trigger_press2_price),

        trigger_exit_price:
          numberOrNull(it.trigger_exit_price),
      };

      const existing = positions.get(symbol);

      if (!existing) {
        positions.set(symbol, state);

        wsSend({
          type: "subscribe",
          symbol,
        });

        console.log(
          `[sync] + ${symbol} side=${state.side}`
        );
      } else {
        // Base44 is authoritative.
        Object.assign(existing, state);
      }
    }

    // Remove anything Base44 no longer reports as open.
    for (const symbol of Array.from(positions.keys())) {
      if (!seen.has(symbol)) {
        dropPosition(symbol, "closed_on_base44");
      }
    }

    console.log(
      `[sync] ${positions.size} open position(s): ` +
      (positions.size
        ? Array.from(positions.keys()).join(", ")
        : "(none)")
    );

  } catch (err) {
    console.error(
      "[sync] error:",
      err.message
    );
  }
}


// ------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const n = Number(value);

  return Number.isFinite(n) ? n : null;
}


function isLong(position) {
  return position.side === "long";
}


function hitsStop(position, price) {
  if (position.current_stop == null) {
    return false;
  }

  return isLong(position)
    ? price <= position.current_stop
    : price >= position.current_stop;
}


function hitsProfitLevel(position, price, level) {
  if (level == null) {
    return false;
  }

  return isLong(position)
    ? price >= level
    : price <= level;
}


// ------------------------------------------------------------
// BASE44 REAL-TIME EVENT
// ------------------------------------------------------------

async function fireEvent(
  positionId,
  symbol,
  realtimePrice,
  event
) {
  const res = await fetch(EVENT_ENDPOINT, {
    method: "POST",

    headers: {
      Authorization: `Bearer ${BASE44_API_KEY}`,
      "Content-Type": "application/json",
    },

    body: JSON.stringify({
      positionId,
      symbol,
      realtimePrice,
      event,
    }),
  });

  let body = null;

  try {
    body = await res.json();
  } catch (_) {
    // Leave body null if Base44 returned no JSON.
  }

  if (res.status === 404) {
    console.log(
      `[event] ${symbol} ${event}: position not found`
    );

    return {
      not_found: true,
    };
  }

  if (res.status === 409) {
    console.error(
      `[event] ${symbol} ${event}: symbol mismatch`,
      body
    );

    return {
      symbol_mismatch: true,
      ...body,
    };
  }

  if (!res.ok) {
    throw new Error(
      `Base44 event HTTP ${res.status}: ${JSON.stringify(body)}`
    );
  }

  return body;
}


// ------------------------------------------------------------
// APPLY BASE44 RESPONSE TO LOCAL STATE
// ------------------------------------------------------------

function syncFromResponse(symbol, response) {
  if (!response) return;

  const position = positions.get(symbol);

  if (!position) return;

  if (response.shares !== undefined) {
    position.shares = response.shares;
  }

  if (response.weighted_avg_cost !== undefined) {
    position.weighted_avg_cost =
      response.weighted_avg_cost;
  }

  if (response.current_stop !== undefined) {
    position.current_stop =
      numberOrNull(response.current_stop);
  }

  if (response.trigger_press1_price !== undefined) {
    position.trigger_press1_price =
      numberOrNull(response.trigger_press1_price);
  }

  if (response.trigger_press2_price !== undefined) {
    position.trigger_press2_price =
      numberOrNull(response.trigger_press2_price);
  }

  if (response.trigger_exit_price !== undefined) {
    position.trigger_exit_price =
      numberOrNull(response.trigger_exit_price);
  }

  if (typeof response.pressed_1r === "boolean") {
    position.pressed_1r =
      response.pressed_1r;
  }

  if (typeof response.pressed_2r === "boolean") {
    position.pressed_2r =
      response.pressed_2r;
  }

  if (typeof response.status === "string") {
    position.status =
      response.status;
  }
}


function isClosedResponse(response) {
  return !!response &&
    (
      response.status === "closed" ||
      response.closed === true ||
      response.already_closed === true
    );
}


// ------------------------------------------------------------
// REMOVE POSITION FROM REAL-TIME MONITOR
// ------------------------------------------------------------

function dropPosition(symbol, reason) {
  if (!positions.has(symbol)) {
    return;
  }

  positions.delete(symbol);
  busy.delete(symbol);

  wsSend({
    type: "unsubscribe",
    symbol,
  });

  console.log(
    `[drop] ${symbol} (${reason})`
  );
}


// ------------------------------------------------------------
// REAL-TIME TICK PROCESSING
//
// ORDER:
//
// stop
// press1
// press2
// exit_900
//
// After every event, Base44 returns the new levels.
// Those new levels are used before evaluating the next event.
// ------------------------------------------------------------

async function evaluateTick(symbol, price) {
  let position = positions.get(symbol);

  if (!position) return;

  if (position.status !== "open") {
    return;
  }

  // Only one event chain per Position at a time.
  if (busy.has(symbol)) {
    return;
  }

  busy.add(symbol);

  try {

    // --------------------------------------------------------
    // 1. HARD STOP
    // --------------------------------------------------------

    if (hitsStop(position, price)) {
      const response =
        await fireEvent(
          position.id,
          symbol,
          price,
          "stop"
        );

      if (response?.not_found) {
        dropPosition(
          symbol,
          "position_not_found"
        );
        return;
      }

      syncFromResponse(
        symbol,
        response
      );

      if (isClosedResponse(response)) {
        dropPosition(
          symbol,
          "stop_hit"
        );
      }

      return;
    }


    // --------------------------------------------------------
    // 2. PRESS 1 — +$200
    // --------------------------------------------------------

    if (
      !position.pressed_1r &&
      hitsProfitLevel(
        position,
        price,
        position.trigger_press1_price
      )
    ) {

      const response =
        await fireEvent(
          position.id,
          symbol,
          price,
          "press1"
        );

      if (response?.not_found) {
        dropPosition(
          symbol,
          "position_not_found"
        );
        return;
      }

      syncFromResponse(
        symbol,
        response
      );

      if (isClosedResponse(response)) {
        dropPosition(
          symbol,
          "closed_after_press1"
        );
        return;
      }

      position =
        positions.get(symbol);

      if (!position) return;
    }


    // --------------------------------------------------------
    // 3. PRESS 2 — +$400
    //
    // Uses the NEW trigger levels returned after press1.
    // --------------------------------------------------------

    if (
      position.pressed_1r &&
      !position.pressed_2r &&
      hitsProfitLevel(
        position,
        price,
        position.trigger_press2_price
      )
    ) {

      const response =
        await fireEvent(
          position.id,
          symbol,
          price,
          "press2"
        );

      if (response?.not_found) {
        dropPosition(
          symbol,
          "position_not_found"
        );
        return;
      }

      syncFromResponse(
        symbol,
        response
      );

      if (isClosedResponse(response)) {
        dropPosition(
          symbol,
          "closed_after_press2"
        );
        return;
      }

      position =
        positions.get(symbol);

      if (!position) return;
    }


    // --------------------------------------------------------
    // 4. EXIT AT +$900
    //
    // Uses the final levels returned after any presses.
    // --------------------------------------------------------

    if (
      hitsProfitLevel(
        position,
        price,
        position.trigger_exit_price
      )
    ) {

      const response =
        await fireEvent(
          position.id,
          symbol,
          price,
          "exit_900"
        );

      if (response?.not_found) {
        dropPosition(
          symbol,
          "position_not_found"
        );
        return;
      }

      syncFromResponse(
        symbol,
        response
      );

      if (isClosedResponse(response)) {
        dropPosition(
          symbol,
          "exit_900"
        );
        return;
      }
    }

  } catch (err) {

    console.error(
      `[tick] ${symbol} error:`,
      err.message
    );

  } finally {

    busy.delete(symbol);
  }
}


// ------------------------------------------------------------
// FINNHUB WEBSOCKET
// ------------------------------------------------------------

function wsSend(message) {
  if (
    ws &&
    ws.readyState === WebSocket.OPEN
  ) {
    ws.send(
      JSON.stringify(message)
    );
  }
}


function connectWebSocket() {
  console.log(
    "Connecting to Finnhub WebSocket..."
  );

  ws =
    new WebSocket(
      FINNHUB_WS_URL
    );


  ws.on("open", () => {

  

    console.log(
      "Connected to Finnhub WebSocket"
    );

    // Re-subscribe everything after reconnect.
    for (
      const symbol
      of positions.keys()
    ) {

      wsSend({
        type: "subscribe",
        symbol,
      });
    }
  });


  ws.on("message", raw => {
console.log("[tick] Finnhub message received");
    let message;

    try {
      message =
        JSON.parse(
          raw.toString()
        );
    } catch (_) {
      return;
    }


    if (
      message.type === "trade" &&
      Array.isArray(message.data)
    ) {

      for (
        const trade
        of message.data
      ) {

        const symbol =
          String(
            trade.s || ""
          ).toUpperCase();

        const price =
          Number(
            trade.p
          );

        if (
          symbol &&
          Number.isFinite(price) &&
          price > 0
        ) {
console.log(`[price] ${symbol} ${price}`);
          evaluateTick(
            symbol,
            price
          );
        }
      }

      return;
    }


    if (
      message.type === "error"
    ) {

      console.error(
        "[ws] Finnhub error:",
        message.msg
      );
    }
  });


  ws.on("close", () => {

    console.log(
      "Finnhub WebSocket disconnected"
    );

    scheduleReconnect();
  });


  ws.on("error", err => {

    console.error(
      "[ws] error:",
      err.message
    );
  });
}


// ------------------------------------------------------------
// RECONNECT
// ------------------------------------------------------------

function scheduleReconnect() {

  if (reconnectTimer) {
    return;
  }

  reconnectAttempts++;

  const delay =
    Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS *
      Math.pow(
        2,
        reconnectAttempts - 1
      )
    );

  console.log(
    `[ws] reconnecting in ${delay} ms`
  );

  reconnectTimer =
    setTimeout(() => {

      reconnectTimer = null;

      connectWebSocket();

    }, delay);
}


// ------------------------------------------------------------
// START
// ------------------------------------------------------------

async function start() {

  console.log(
    "Starting DART real-time stop/press/exit worker (paper, USD)..."
  );

  // Discover any Position already open.
  await syncWithBase44();

  // Start live Finnhub feed.
  connectWebSocket();

  // Discover newly opened Positions quickly.
  setInterval(
    syncWithBase44,
    SYNC_INTERVAL_MS
  );
}


start().catch(err => {

  console.error(
    "Worker startup failed:",
    err
  );

  process.exit(1);
});
