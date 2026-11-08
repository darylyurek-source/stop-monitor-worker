// feedStandby.js — the Finnhub standby feed for Massive mode.
//
// In massive mode Massive is the price source and Finnhub is a WARM STANDBY: the
// standby socket stays connected with every open symbol subscribed, but a Finnhub
// print is only allowed to route a symbol when Massive has gone quiet on it.
//
//   Massive current (a print within STALE_AFTER_MS)  → the Finnhub print is dropped.
//   Massive quiet longer than STALE_AFTER_MS         → the Finnhub print is used and a
//                                                      takeover starts.
//   Massive prints again                              → the takeover ends, the symbol is
//                                                      back on Massive.
//
// Two guards apply to every standby price, so a backup can never reprice the book on a
// bad print: the print itself must describe the present (MAX_PRINT_AGE_MS), and it may
// not sit further than MAX_DEVIATION from the last accepted price for that symbol.
//
// This module holds no socket and reads no clock: every entry point takes the time it
// is called with, which is what lets the self-test drive a dropout exactly. It decides
// nothing about trading — it only answers whether a price may be used.
//
// Every takeover is kept: symbol, when Finnhub started serving it, when Massive took it
// back, how long that lasted and how many standby prints it carried.

export const STALE_AFTER_MS = 15000;      // how long Massive may be silent before Finnhub covers a symbol
export const MAX_PRINT_AGE_MS = 60000;    // a standby print older than this describes a finished tape
export const MAX_DEVIATION = 0.03;        // a standby price this far from the last accepted price is a bad print

const HISTORY_LIMIT = 200;

const massiveAt = new Map();    // symbol -> ms of the last Massive-sourced price
const lastAccepted = new Map(); // symbol -> last price this worker accepted (either feed)
const active = new Map();       // symbol -> the takeover in progress
const completed = [];           // finished takeovers, oldest first

const dropped = { massiveCurrent: 0, stalePrint: 0, deviation: 0 };

function norm(symbol) {
  return String(symbol || "").toUpperCase();
}

// A Massive price (stream trade or REST snapshot). Marks the symbol current and, if
// Finnhub was covering it, ends that takeover — returning the record so the caller can
// log how long the standby was used.
export function noteMassive(symbol, price, at = Date.now()) {
  const s = norm(symbol);
  const numeric = Number(price);
  if (!s || !Number.isFinite(numeric) || numeric <= 0) return null;

  massiveAt.set(s, at);
  lastAccepted.set(s, numeric);

  const takeover = active.get(s);
  if (!takeover) return null;

  active.delete(s);
  const record = {
    symbol: s,
    startedAt: takeover.startedAt,
    endedAt: at,
    durationMs: Math.max(0, at - takeover.startedAt),
    prints: takeover.prints,
    firstPrice: takeover.firstPrice,
    lastPrice: takeover.lastPrice,
    massivePrice: numeric,
  };
  completed.push(record);
  if (completed.length > HISTORY_LIMIT) completed.shift();
  return record;
}

// May this Finnhub print route this symbol? Only when Massive is stale for it, the
// print describes the present, and it does not reprice the book.
export function admitFinnhub(symbol, price, { now = Date.now(), exchangeMs = null } = {}) {
  const s = norm(symbol);
  const numeric = Number(price);
  if (!s) return { use: false, reason: "no_symbol" };
  if (!Number.isFinite(numeric) || numeric <= 0) return { use: false, reason: "bad_price" };

  // 1. Massive current — the standby has nothing to add.
  const massive = massiveAt.get(s) || 0;
  const massiveAgeMs = now - massive;
  if (massiveAgeMs <= STALE_AFTER_MS) {
    dropped.massiveCurrent += 1;
    return { use: false, reason: "massive_current", massiveAgeMs };
  }

  // 2. The print itself must describe the present, not a finished tape. A socket print
  //    carries the venue's own stamp; one without a stamp is judged on the routing
  //    staleness above alone, exactly as the REST quote path always has.
  const stamp = Number(exchangeMs);
  if (Number.isFinite(stamp) && stamp > 0) {
    const printAgeMs = now - stamp;
    if (printAgeMs > MAX_PRINT_AGE_MS) {
      dropped.stalePrint += 1;
      return { use: false, reason: "stale_print", printAgeMs, massiveAgeMs };
    }
  }

  // 3. A standby price may not reprice the book.
  const previous = lastAccepted.get(s);
  if (previous) {
    const deviation = Math.abs(numeric - previous) / previous;
    if (deviation > MAX_DEVIATION) {
      dropped.deviation += 1;
      return { use: false, reason: "deviation", deviation, previous, massiveAgeMs };
    }
  }

  lastAccepted.set(s, numeric);

  let takeover = active.get(s);
  const started = !takeover;
  if (started) {
    takeover = { symbol: s, startedAt: now, prints: 0, firstPrice: numeric, lastPrice: numeric };
    active.set(s, takeover);
  }
  takeover.prints += 1;
  takeover.lastPrice = numeric;
  takeover.lastAt = now;

  return {
    use: true,
    reason: "takeover",
    started,
    prints: takeover.prints,
    massiveAgeMs,
  };
}

export function activeTakeovers(now = Date.now()) {
  return [...active.values()].map((t) => ({
    symbol: t.symbol,
    startedAt: t.startedAt,
    ageMs: Math.max(0, now - t.startedAt),
    prints: t.prints,
    lastPrice: t.lastPrice,
  }));
}

export function takeovers() {
  return completed.slice();
}

export function summary(now = Date.now()) {
  const running = activeTakeovers(now);
  const finnhubPrints =
    completed.reduce((sum, t) => sum + t.prints, 0) +
    running.reduce((sum, t) => sum + t.prints, 0);
  return {
    takeovers: completed.length,
    active: running,
    activeCount: running.length,
    finnhubPrints,
    totalTakeoverMs: completed.reduce((sum, t) => sum + t.durationMs, 0),
    longestMs: completed.reduce((max, t) => Math.max(max, t.durationMs), 0),
    dropped: { ...dropped },
    last: completed.length ? completed[completed.length - 1] : null,
  };
}

// Test support only: forget everything this process has seen.
export function reset() {
  massiveAt.clear();
  lastAccepted.clear();
  active.clear();
  completed.length = 0;
  dropped.massiveCurrent = 0;
  dropped.stalePrint = 0;
  dropped.deviation = 0;
}