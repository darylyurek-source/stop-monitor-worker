// dBudget.js — DART D's DAILY BUYING POWER, as this worker sees it.
//
// D's press is the one press in the family that is not a constant: it is $120,000 or
// the buying power still free at the moment it fires, whichever is smaller, and below
// $20,000 free it is skipped entirely (shared/dPressBudget.ts).
//
//   buying power = 3 x D's account value, fixed once each morning and held for the
//                  whole session — Base44 writes that one DPressBudget row per day,
//   free         = that figure less the cost basis of every open D position.
//
// So the worker needs ONE number from Base44 per session (the day's buying power) and
// nothing else: what is committed comes from its own in-memory book, which is why
// sizing a press costs no query and can be done on the tick path.
//
// The budget is carried on the monitoring response the worker already fetches every
// 15 seconds (`press_budgets.D`), so this file adds no request of its own. With no row
// for today — D halted, or the day's budget not yet fixed — the press is never sized
// from a stale figure and never guessed: pressSizing returns nulls and the engine
// answers "needs_budget" instead of pressing.

import { pressPlan, freeBuyingPower, dPressSizeFor } from "./tickRules.js";
import { sumTcb } from "./positionBook.js";

const etDateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

// The ET calendar date (YYYY-MM-DD) an instant belongs to.
export function etDate(nowMs = Date.now()) {
  try {
    return etDateFmt.format(new Date(nowMs));
  } catch (_) {
    return null;
  }
}

let row = null; // the today's DPressBudget row Base44 last reported

// Take the day's figure from the monitoring response. A response that does not carry
// one (market closed, no row yet) clears it, so a figure can never outlive its day.
export function setFromMonitoring(body) {
  const raw = body?.press_budgets?.D ?? null;
  if (!raw || typeof raw !== "object") {
    row = null;
    return null;
  }
  const buyingPower = Number(raw.buying_power);
  if (!Number.isFinite(buyingPower)) {
    row = null;
    return null;
  }
  row = {
    trade_date: raw.trade_date ? String(raw.trade_date) : null,
    equity: Number(raw.equity) || null,
    buying_power: buyingPower,
  };
  return row;
}

export function current() {
  return row;
}

export function clear() {
  row = null;
}

// Buying power, what the open book has committed, and what is free — for today only.
// Returns null when the account is not dynamically sized or the day's figure is not
// known, so the caller can tell "no press" from "press of unknown size".
export function pressSizing(system, nowMs = Date.now()) {
  if (pressPlan(system)?.dynamicSize !== true) return null;
  const today = etDate(nowMs);
  if (!row || !today || row.trade_date !== today) return null;
  const deployed = sumTcb(system);
  const free = freeBuyingPower(row.buying_power, deployed);
  return {
    trade_date: row.trade_date,
    buying_power: row.buying_power,
    deployed,
    free,
    pressSizeUsd: dPressSizeFor(free),
  };
}