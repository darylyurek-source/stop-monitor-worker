// protectiveTrigger.js — THE PORTABLE PROTECTIVE-STOP TRIGGER (Render worker).
//
// A dependency-free, side-effect-free re-implementation of the in-trade Vector
// deterioration test in Base44's functions/manageProtectiveStops/entry.ts. It answers
// one question per call:
//
//     has this open position's trend deteriorated enough for its protective stop to arm?
//
// and returns the answer as data. It opens no connection, reads no clock, writes
// nothing. In shadow mode the caller RECORDS the verdict and compares it with
// Base44's own. Nothing here can arm, alter or close a trade.
//
// THE RULE, COPIED FROM THE LIVE FUNCTION (no tuning, no reordering):
//   1. Only an OPEN position that has NOT armed is assessed; closed, already-armed
//      and zero-share positions are skipped.
//   2. Candles are the 1-minute series from the 9:30 ET open up to now, and the bar
//      scored is the LAST one — the bar still forming, whose close is the price at
//      that instant. (This is the convention the historical validation established;
//      scoring the last COMPLETED bar shifts every short-window component.)
//   3. Stock score  = computeVector(candles, last, side, position.entry_price)
//      Market score = computeMarketVector(SPY candles, side) — SPY's 9:30 open is the
//      market entry reference, and the market is scored in the stock trade's own side.
//   4. It arms when stock >= policy.stockThreshold OR market >= policy.marketThreshold,
//      thresholds taken from the SAME protectivePolicy() row the tick engine uses to
//      enforce the giveback (B/ANEW/A 55-65, C/D/E 65-85, $350 buffer).
//   5. On arming, the high-water is the unrealized P&L at the bar's FAVOURABLE EXTREME,
//      not at the current price: the bar's high for a long, its low for a short,
//      falling back to the close when the bar carries no extreme. That single line is
//      why a live armed high-water can read a little above the price that armed it.
//   6. A missing feed is never treated as calm: with neither candles nor an injected
//      score the verdict is "no_candles" and nothing arms.
//
// Paper only. USD. No state is held between calls.

import { r2, unrealized, protectivePolicy, ruleKeyFor } from "./tickRules.js";
import { computeStockVector, computeMarketVector } from "./vectorCore.js";

// The score of the last bar, or null when the series cannot score it.
export function scoreLastBar(candles, side, entryPrice) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  const v = computeStockVector(candles, candles.length - 1, side, entryPrice);
  return v ? Number(v.combined_reversal_score) : null;
}

export function assessProtectiveTrigger(args) {
  const { system, position: pos, nowIso } = args || {};
  const sys = String(system ?? "").trim().toUpperCase();
  // THE RULES THIS POSITION LIVES UNDER: its system's row, or C_LEGACY for a DART C
  // position opened before that account's 2026-11-16 9:30 AM ET cutover — a stop is
  // armed on the rules the position was opened with (tickRules.ruleKeyFor).
  const ruleKey = ruleKeyFor(sys, pos);
  const policy = protectivePolicy(ruleKey);
  const stockThreshold = policy.stockThreshold;
  const marketThreshold = policy.marketThreshold;

  const base = {
    system: sys,
    rule_key: ruleKey,
    symbol: pos?.symbol ?? null,
    stock_threshold: stockThreshold,
    market_threshold: marketThreshold,
  };

  if (!pos) return { ...base, action: "skipped", reason: "position_not_found" };
  if (pos.status === "closed") return { ...base, action: "skipped", reason: "already_closed" };
  if (pos.protective_stop_active) return { ...base, action: "skipped", reason: "already_active" };

  const side = pos.side;
  const shares = Number(pos.shares) || 0;
  if (!(shares > 0)) return { ...base, action: "skipped", reason: "no_shares" };

  const entryPrice = Number(pos.entry_price);
  const tcb = Number(pos.tcb) || 0;
  const candles = Array.isArray(args?.candles) ? args.candles : null;
  const marketCandles = Array.isArray(args?.marketCandles) ? args.marketCandles : null;

  // An injected score is used only when supplied; the computed path is the default.
  const stockScore =
    args?.stockScore != null ? Number(args.stockScore) : scoreLastBar(candles, side, entryPrice);
  const marketObj = marketCandles && marketCandles.length ? computeMarketVector(marketCandles, side) : null;
  const marketScore =
    args?.marketScore != null
      ? Number(args.marketScore)
      : marketObj
      ? Number(marketObj.combined_reversal_score)
      : null;

  const scored = {
    ...base,
    stock_score: stockScore == null ? null : r2(stockScore),
    market_score: marketScore == null ? null : r2(marketScore),
  };

  // Neither leg can be scored: refuse to arm on an absent feed.
  if (stockScore == null && marketScore == null) {
    return { ...scored, action: "no_candles", reason: "no_score_available" };
  }

  const stockHit = stockScore != null && stockScore >= stockThreshold;
  const marketHit = marketScore != null && marketScore >= marketThreshold;
  if (!stockHit && !marketHit) {
    return { ...scored, action: "hold", event: "protective_not_armed" };
  }

  // High-water at the bar's favourable extreme (closes the gap between the price that
  // armed the stop and the high the bar actually printed).
  const last = candles && candles.length ? candles[candles.length - 1] : null;
  let referencePrice = null;
  if (last) {
    if (side === "long") referencePrice = last.high != null ? Number(last.high) : Number(last.close);
    else referencePrice = last.low != null ? Number(last.low) : Number(last.close);
  }
  if (!Number.isFinite(referencePrice)) {
    // No bar to take an extreme from: use the price the caller is scoring at, when given.
    referencePrice = Number.isFinite(Number(args?.price)) ? Number(args.price) : NaN;
  }
  if (!Number.isFinite(referencePrice)) {
    // Arming without a high-water would arm a stop at zero and exit on the next
    // routine dip. Refuse instead: a score with no bar underneath it is not enough.
    return { ...scored, action: "no_reference_price", reason: "no_bar_extreme" };
  }
  const highWater = unrealized(side, referencePrice, shares, tcb);

  return {
    ...scored,
    action: "activate",
    event: "protective_stop_armed",
    triggered_by: stockHit && marketHit ? "both" : stockHit ? "stock" : "market",
    reference_price: r2(referencePrice),
    patch: {
      protective_stop_active: true,
      protective_high_water_pl: r2(highWater),
      protective_triggered_time: nowIso ?? null,
      protective_triggered_stock_vec: stockScore == null ? null : r2(stockScore),
      protective_triggered_market_vec: marketScore == null ? null : r2(marketScore),
    },
  };
}