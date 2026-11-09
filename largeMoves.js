// largeMoves.js — a large move is REPORTED, never refused (2026-11-09).
//
// The percentage band that used to stand on every price path is gone. It could not tell a bad
// price from a good one — a halt resume, an opening gap and a news spike are genuine prints —
// and because the reference price only advanced on an ACCEPTED print, one rejection refused
// every later price too: that symbol then had no hard stop, no trail, no protective arming and
// no 16:00 close. All four accounts are Render-only, so nothing else could close it either.
//
// What remains is this: the same comparison, logged, with the age of the reference. Every line
// it emits describes a price that WAS used. Nothing here returns a verdict a caller could
// refuse a price on — that is the point.

export const LARGE_MOVE_DEVIATION = 0.10; // reported at or beyond this distance from the reference
export const FRESH_ANCHOR_MS = 60000;     // a reference older than this means the book was quiet

const anchor = new Map(); // symbol -> { price, at } — the last price this process accepted
const seen = new Map();   // symbol -> large moves counted this process

const LOG_FIRST = 3; // log the first few per symbol ...
const LOG_EVERY = 25; // ... then every 25th, so a re-rating cannot flood the log

// Record a price and report a large move if it is one. Returns null when there is nothing to
// report, the report otherwise. NEVER returns anything a caller could use to drop the price.
export function noteLargeMove(symbol, price, source = "feed", nowMs = Date.now()) {
  const s = String(symbol || "").toUpperCase();
  const numeric = Number(price);
  if (!s || !Number.isFinite(numeric) || numeric <= 0) return null;

  const previous = anchor.get(s);
  anchor.set(s, { price: numeric, at: nowMs });
  if (!previous) return null;

  const deviation = Math.abs(numeric - previous.price) / previous.price;
  if (deviation <= LARGE_MOVE_DEVIATION) return null;

  const counted = (seen.get(s) || 0) + 1;
  seen.set(s, counted);

  const report = {
    symbol: s,
    price: numeric,
    previous: previous.price,
    deviation,
    counted,
    anchorAgeMs: Math.max(0, nowMs - previous.at),
    logged: false,
  };

  if (counted > LOG_FIRST && counted % LOG_EVERY !== 0) return report;

  report.logged = true;
  console.warn(
    `[move] ${s} ${source} ${numeric.toFixed(2)} is ${(deviation * 100).toFixed(2)}% from ` +
    `${previous.price.toFixed(2)} — ` +
    (report.anchorAgeMs < FRESH_ANCHOR_MS
      ? "in-session jump, the book was live"
      : `resume after ${Math.round(report.anchorAgeMs / 1000)}s without a price`) +
    " — USED, not refused" +
    (counted > LOG_FIRST ? ` (${counted} large move(s) on this symbol)` : "")
  );
  return report;
}

// Totals for the periodic log line.
export function summary() {
  return {
    total: [...seen.values()].reduce((a, b) => a + b, 0),
    symbols: seen.size,
  };
}

// A symbol that is no longer open starts clean: its first price of a new session establishes
// the reference instead of being reported against a price from an earlier session.
export function forget(symbol) {
  const s = String(symbol || "").toUpperCase();
  anchor.delete(s);
  seen.delete(s);
}

// Test support only.
export function reset() {
  anchor.clear();
  seen.clear();
}