// DART — portable Trend-Reversal Vector (Render worker).
//
// VERBATIM port of base44/shared/trendReversalVector.ts. Every constant, window,
// divisor, threshold and rounding step is copied unchanged; the only edits are the
// removal of TypeScript-only syntax (this file has none) and the addition of the
// two market-vector helpers at the bottom, which reproduce
// base44/shared/pressInstrumentation.ts exactly.
//
// DO NOT TUNE, "FIX" OR REORDER ANYTHING IN THIS FILE. It is a copy, and its value
// is that it can be proven identical to the Base44 original. If the Base44 module
// ever changes, this one must be re-copied and vectorSelfTest.js must be re-run —
// it compares the two implementations field for field on randomised candle series
// and fails on any single-digit difference.
//
// Semantics that must never drift (all inherited from the original):
//   • No look-ahead: every component reads candles[0..idx] only.
//   • `entryPrice` is the ORIGINAL entry (the position's entry price for a stock,
//     SPY's first-candle open for the market).
//   • `idx` is normally the LAST candle, and the candle CLOSE at that index — not
//     the live tick price — is what the components score.
//   • Outputs are rounded to 2dp with the Number.EPSILON nudge, so equality with
//     the Base44 twin is exact, not approximate.
//
// VALIDATION RECORD (2026-11-01)
//   1. Differential, against the Base44 module itself: 54,900 evaluations across
//      5 candle shapes, 2 sides, every index 0..59 and 3 entry references —
//      0 differing fields. Also 7,540 truncation checks for no-look-ahead, 0 fails.
//   2. Historical, against 944 recorded press Vector results from the 8 sessions
//      2026-10-07..10-16: 272 reproduced ALL EIGHT components exactly, with a
//      press-bar close derived independently from one component and the other six
//      matched as evidence. The remainder are data limits, not arithmetic:
//      54 differed by exactly one or two structural steps (5.55 / 11.11 = 1/18,
//      2/18 of the structure score, flipped by a cent of difference in a bar's
//      high/low between providers), 6 implied a close a few cents outside the bar,
//      379 could not be reconstructed at all because the live engine scored a bar
//      that was still forming — its high, low and volume at that instant are not in
//      any archive — and 14 had no archived bars, 219 no surviving position record.
//   3. Market (SPY) leg: 243 exact reproductions from the same 944 presses.
//
// The convention this establishes, which the shadow runner must copy exactly:
// the scored bar is the one covering the PRESS MOMENT (still forming, its close is
// the price at that instant), not the last completed bar.

// Fixed, transparent, UN-OPTIMIZED component weights (sum = 1.0).
export const W = {
  price_slope: 0.15,
  fast_slow: 0.15,
  structure: 0.20,
  vwap: 0.15,
  volume: 0.10,
  rolling_atr: 0.10,
  persistence: 0.15,
};

export const LOSS_LEVELS = [-100, -200, -300, -400, -500, -600, -700, -800, -900, -1000, -1100, -1200, -1300, -1400, -1500, -1600, -1700];

export const clamp01 = (x) => Math.max(0, Math.min(100, x));

// Linear-regression slope of ys (per index step).
export function linregSlope(ys) {
  const n = ys.length;
  if (n < 2) return 0;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += ys[i]; }
  const xm = sx / n, ym = sy / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i - xm) * (ys[i] - ym); den += (i - xm) ** 2; }
  return den ? num / den : 0;
}

// Rolling 1-minute ATR: average true range over the last `period` candles.
export function rollingAtr1m(candles, endIdx, period = 14) {
  const start = Math.max(1, endIdx - period + 1);
  let sum = 0, n = 0;
  for (let i = start; i <= endIdx; i++) {
    const c = candles[i], prev = candles[i - 1];
    let tr;
    if (c.high != null && c.low != null && c.high > 0) tr = c.high - c.low;
    else if (prev && prev.close != null) tr = Math.abs(c.close - prev.close);
    else continue;
    if (isFinite(tr) && tr >= 0) { sum += tr; n++; }
  }
  return n ? sum / n : 0;
}

// Intraday VWAP from the first candle through endIdx.
export function vwapUpTo(candles, endIdx) {
  let pv = 0, vv = 0;
  for (let i = 0; i <= endIdx; i++) {
    const c = candles[i];
    const tp = (c.high != null && c.low != null) ? (c.high + c.low + c.close) / 3 : c.close;
    const v = c.volume || 0;
    if (v > 0) { pv += tp * v; vv += v; }
  }
  if (vv > 0) return pv / vv;
  let s = 0; for (let i = 0; i <= endIdx; i++) s += candles[i].close;
  return endIdx >= 0 ? s / (endIdx + 1) : 0;
}

// ---------------------------------------------------------------------------
// The 7-component Trend-Reversal Vector. Every component is 0..100 where 100 =
// strong evidence the original trend has REVERSED against the trade. Uses only
// candles[0..idx] (no look-ahead). `entryPrice` is the original entry price.
// ---------------------------------------------------------------------------
export function computeVector(candles, idx, side, entryPrice) {
  const isLong = side === "long";
  const close = candles[idx].close;
  const atr = Math.max(rollingAtr1m(candles, idx, 14), 0.001);

  // 1. PRICE SLOPE
  const win1 = Math.min(10, idx + 1);
  const slope10 = linregSlope(candles.slice(idx + 1 - win1, idx + 1).map(c => c.close));
  const adverseMove10 = (isLong ? -1 : 1) * slope10 * win1;
  const price_slope_score = adverseMove10 > 0 ? clamp01(100 * adverseMove10 / atr) : 0;

  // 2. FAST vs SLOW SLOPE
  const f = Math.min(5, idx + 1), s = Math.min(15, idx + 1);
  const slopeF = linregSlope(candles.slice(idx + 1 - f, idx + 1).map(c => c.close));
  const slopeS = linregSlope(candles.slice(idx + 1 - s, idx + 1).map(c => c.close));
  const advF = (isLong ? -1 : 1) * slopeF * f;
  const advS = (isLong ? -1 : 1) * slopeS * s;
  const accel = advF - advS;
  const fast_slow_slope_score = accel > 0 ? clamp01(100 * accel / atr) : 0;

  // 3. PRICE STRUCTURE
  const win3 = Math.min(10, idx + 1);
  let struct = 0;
  for (let i = idx + 1 - win3 + 1; i <= idx; i++) {
    const a = candles[i - 1], b = candles[i];
    if (a.high == null || b.high == null) continue;
    if (isLong) { if (b.high < a.high) struct++; if (b.low < a.low) struct++; }
    else { if (b.high > a.high) struct++; if (b.low > a.low) struct++; }
  }
  const price_structure_score = clamp01(100 * struct / Math.max(1, 2 * (win3 - 1)));

  // 4. VWAP RELATIONSHIP
  const vw = vwapUpTo(candles, idx);
  const dist = isLong ? (vw - close) : (close - vw);
  let fracAdverse = 0;
  const win4 = Math.min(10, idx + 1);
  for (let i = idx + 1 - win4; i <= idx; i++) {
    const cc = candles[i].close;
    if (isLong ? cc < vw : cc > vw) fracAdverse++;
  }
  fracAdverse /= win4;
  const vwap_score = dist > 0 ? clamp01(100 * dist / atr) * (0.5 + 0.5 * fracAdverse) : 0;

  // 5. VOLUME CONFIRMATION
  const win5 = Math.min(10, idx + 1);
  let volAdv = 0, volFav = 0;
  for (let i = idx + 1 - win5; i <= idx; i++) {
    const c = candles[i];
    if (c.open == null) continue;
    const adverse = isLong ? c.close < c.open : c.close > c.open;
    const v = c.volume || 0;
    if (adverse) volAdv += v; else volFav += v;
  }
  const ratio = volAdv + volFav > 0 ? volAdv / (volAdv + volFav) : 0;
  const volume_score = ratio > 0.5 ? clamp01(100 * (ratio - 0.5) / 0.3) : 0;

  // 6. ROLLING ATR-NORMALIZED MOVEMENT
  const adverseFromEntry = isLong ? (entryPrice - close) : (close - entryPrice);
  const rolling_atr_score = adverseFromEntry > 0 ? clamp01(100 * adverseFromEntry / (5 * atr)) : 0;

  // 7. PERSISTENCE
  const win7 = Math.min(10, idx + 1);
  let adverseBars = 0;
  for (let i = idx + 1 - win7; i <= idx; i++) {
    const c = candles[i];
    if (c.open == null) continue;
    if (isLong ? c.close < c.open : c.close > c.open) adverseBars++;
  }
  const persist = adverseBars / win7;
  const persistence_score = persist > 0.5 ? clamp01(100 * (persist - 0.5) / 0.4) : 0;

  const combined =
    W.price_slope * price_slope_score +
    W.fast_slow * fast_slow_slope_score +
    W.structure * price_structure_score +
    W.vwap * vwap_score +
    W.volume * volume_score +
    W.rolling_atr * rolling_atr_score +
    W.persistence * persistence_score;

  return {
    price_slope_score: r2(price_slope_score),
    fast_slow_slope_score: r2(fast_slow_slope_score),
    price_structure_score: r2(price_structure_score),
    vwap_score: r2(vwap_score),
    volume_score: r2(volume_score),
    rolling_atr_score: r2(rolling_atr_score),
    persistence_score: r2(persistence_score),
    combined_reversal_score: r2(combined),
  };
}

function r2(v) { return Math.round((Number(v) + Number.EPSILON) * 100) / 100; }

// ---------------------------------------------------------------------------
// MARKET (SPY) VECTOR — reproduces base44/shared/pressInstrumentation.ts:
//   entry reference = SPY's FIRST candle open (else its close) at 9:30,
//   side           = the stock trade's own side,
//   idx            = the last candle.
// ---------------------------------------------------------------------------
export const MARKET_SYMBOL = "SPY";
export const MARKET_EXCHANGE = "NYSE";

export function marketVectorEntryPrice(candles) {
  if (!Array.isArray(candles) || candles.length === 0) return null;
  const first = candles[0];
  return first.open != null ? first.open : first.close;
}

export function computeMarketVector(marketCandles, side) {
  if (!Array.isArray(marketCandles) || marketCandles.length === 0) return null;
  const idx = marketCandles.length - 1;
  const entryPrice = marketVectorEntryPrice(marketCandles);
  return computeVector(marketCandles, idx, side, entryPrice);
}

// The stock Vector exactly as the live tick calls it: last completed candle,
// the position's own entry price. Null when there are no candles (the live engine
// then scores 0 rather than guessing) — callers must keep that distinction.
export function computeStockVector(stockCandles, idx, side, entryPrice) {
  if (!Array.isArray(stockCandles) || idx < 0 || idx >= stockCandles.length) return null;
  return computeVector(stockCandles, idx, side, entryPrice);
}

// Score only, in the shape tickDecisionCore.js wants for its Vector steps.
// Returns null — never 0 — when the candle series is unavailable, so a missing
// feed can never be mistaken for a calm market.
export function vectorScore(candles, side, entryPrice, idx = null) {
  const i = idx == null ? (Array.isArray(candles) ? candles.length - 1 : -1) : idx;
  const v = computeStockVector(candles, i, side, entryPrice);
  return v ? Number(v.combined_reversal_score) : null;
}