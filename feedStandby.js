// feedStandby.js — the REST standby for Massive mode.
//
// Massive is the ONE price source. There is no second vendor (2026-11-11: Finnhub is
// out of the price path for good — it produced ghost prices). The backup is Massive's
// own REST lookup, used only when the Massive STREAM has gone quiet on a symbol:
//
//   stream print within STALE_AFTER_MS  → the REST print is dropped; the stream owns it.
//   stream quiet longer than that       → the REST snapshot's last trade is used and a
//                                         takeover starts.
//   stream prints again                 → the takeover ends, the symbol is back on the
//                                         stream.
//
// One guard applies to every standby price: the print itself must describe the present
// (MAX_PRINT_AGE_MS). MAGNITUDE IS NOT A GUARD (2026-11-09) — a standby price at a new
// level is exactly how a resumed symbol is recovered, so a percentage band here would
// refuse the halt resume the standby exists to carry. Large moves are logged by the
// router (worker.js noteLargeMove), never dropped.
//
// This module holds no socket and reads no clock: every entry point takes the time it
// is called with, which is what lets the self-test drive a dropout exactly. It decides
// nothing about trading — it only answers whether a price may be used.
//
// Every takeover is kept: symbol, when the REST lookup started serving it, when the stream
// took it back, how long that lasted and how many standby prints it carried.

import { SOURCE_LIMITS } from "./tradeConditions.js";

export const STALE_AFTER_MS = 15000;      // how long the stream may be silent before the REST lookup covers a symbol
// ONE freshness table for every source (tradeConditions.SOURCE_LIMITS), so this file cannot
// hold its own private idea of "current" and drift away from the gate's.
export const MAX_PRINT_AGE_MS = SOURCE_LIMITS.massive_snapshot;

const HISTORY_LIMIT = 200;

const massiveAt = new Map();    // symbol -> ms of the last Massive-sourced price
const lastAccepted = new Map(); // symbol -> last price this worker accepted (stream or REST)
const active = new Map();       // symbol -> the takeover in progress
const completed = [];           // finished takeovers, oldest first

const dropped = { massiveCurrent: 0, stalePrint: 0, noStamp: 0 };

function norm(symbol) {
  return String(symbol || "").toUpperCase();
}

// A Massive price (stream trade). Marks the symbol current and, if the REST lookup was
// covering it, ends that takeover — returning the record so the caller can log how long the
// standby was used.
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

// How long the stream has been silent on this symbol (Infinity when it has never printed).
export function massiveAgeMs(symbol, now = Date.now()) {
  const at = massiveAt.get(norm(symbol)) || 0;
  return at ? now - at : Infinity;
}

// May this REST snapshot print route this symbol? Only when the stream is stale for it and
// the print describes the present. Same provider, so there is nothing to re-decide about
// provenance beyond that.
export function admitRest(symbol, price, { now = Date.now(), exchangeMs = null } = {}) {
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

  // 2. The print must carry its own execution stamp AND describe the present. A print with no
  //    stamp cannot be judged at all, and an unjudgeable price is not a price: it is REFUSED,
  //    never admitted on the routing staleness alone (that was the 2026-11-09 hole — the
  //    stream, the snapshot and the standby each judged provenance to a different standard).
  const stamp = Number(exchangeMs);
  if (!Number.isFinite(stamp) || stamp <= 0) {
    dropped.noStamp += 1;
    return { use: false, reason: "no_stamp", massiveAgeMs };
  }
  const printAgeMs = now - stamp;
  if (printAgeMs > MAX_PRINT_AGE_MS) {
    dropped.stalePrint += 1;
    return { use: false, reason: "stale_print", printAgeMs, massiveAgeMs };
  }

  // 3. NO MAGNITUDE TEST. The price is used whatever its distance from the last accepted
  //    price: on a resume after a halt that distance IS the news, and refusing it would
  //    leave the symbol uncovered by either feed. A large move is reported by the router.
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
  const restPrints =
    completed.reduce((sum, t) => sum + t.prints, 0) +
    running.reduce((sum, t) => sum + t.prints, 0);
  return {
    takeovers: completed.length,
    active: running,
    activeCount: running.length,
    restPrints,
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
  dropped.noStamp = 0;
}