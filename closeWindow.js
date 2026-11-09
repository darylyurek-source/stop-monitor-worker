// closeWindow.js — when a position is owed its session close, and at what price.
//
// Pure by design: no clock beyond the one it is handed, no book, no socket, no database. That
// is what lets the self-test drive the close window directly, so "every position can still
// reach its scheduled closing procedure" is checked rather than asserted.

import { SESSION_CLOSE_MINUTE } from "./tickDecisionCore.js";

// The ET calendar day and minute-of-day, read from the clock instead of from a price.
export function etNow(nowMs = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(nowMs));
  const get = (type) => (parts.find((p) => p.type === type) || {}).value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

// Is this position owed its scheduled close? The clock, not a price: the session mark has
// passed and the position is still open.
//
// A position that somehow survived an earlier session is managed by DART's own rules during
// the next session and closed at that session's mark — it is never forced intraday. The sweep
// adds no rule and no minute DART does not already have; it only makes sure the one that exists
// does not depend on a trade arriving.
export function isDueForClose({ position, nowMinutes }) {
  if (!position || String(position.status) !== "open") return false;
  return Number(nowMinutes) >= SESSION_CLOSE_MINUTE;
}

// The price to close at: the last price this process accepted for the symbol, else the
// position's own last stored price. Both are prices DART has already valued the position at,
// so the close is never invented — and never blocked by a feed that went quiet. A price is
// never chosen by how far it moved.
export function closePriceFor(position, priceFor) {
  let live = null;
  try {
    live = Number(priceFor?.(String(position?.symbol || "")));
  } catch (_) {
    live = null;
  }
  if (Number.isFinite(live) && live > 0) return { price: live, basis: "last accepted price" };
  const stored = Number(position?.current_price);
  if (Number.isFinite(stored) && stored > 0) return { price: stored, basis: "last stored price" };
  return null;
}