// tickDecisionCore.js — THE PORTABLE PER-TICK DECISION ENGINE.
//
// A dependency-free, side-effect-free re-implementation of the decision ordering in
// Base44's shared/cloneTick.ts. It answers exactly one question per call:
//
//     given this position, this live price, this Vector score and this instant,
//     what would the live tick engine DO?
//
// and returns the answer as data. It opens no connection, reads no clock, touches no
// database, writes nothing and returns no executable action: the caller decides what
// to do with the verdict. In shadow mode the caller RECORDS it and compares it with
// Base44's own verdict. Nothing here can place, alter or close a trade.
//
// DECISION ORDER (identical to cloneTick.ts — the order is part of the rules, a
// stop is evaluated before a press even when both are true at the same price):
//
//   1. halted / closed / not found guard
//   2. share-price trail activation (at Press 2) — a state write, then
//   3. TERMINAL: hard stop (systemStop) OR protective giveback OR price-trail breach
//   4. protective high-water ratchet
//   5. price-trail extreme ratchet
//   6. partial profit-taking (B, A/ANEW, C and D — 25% once at +$1,850; C from 2026-11-11)
//   7. downside Vector 65 across newly crossed loss checkpoints (P&L < 0 only)
//   8. upside Vector grid: activation at +$900, then ±$100 steps
//   9. presses: 3R at +$800, 2R at +$700, 1R at the system's own threshold
//  10. hold: display-only marks
//
// THE VECTOR SCORE: computed from 1-minute candles by the Vector module (a separate
// portable port, proven identical to Base44's). Three sources, in this order:
//   1. args.vectorScore — an already-computed score (parity with the live tick, and
//      what the shadow runner passes when it has just scored the same bar).
//   2. args.candles — the engine scores the LAST bar with the position's own entry
//      price, exactly as cloneTick.ts does (idx = candles.length - 1).
//   3. args.liveZeroFallback — reproduces the live engine's own fallback: when its
//      candle fetch returns nothing it uses 0. Off by default, because 0 is a real
//      score and a dead feed must not be mistaken for a calm market.
// With none of the three, a step needing the score returns action "needs_vector"
// naming the step — never a guess, never a default score.
//
// Paper only. USD. No trading state is held between calls.

import {
  r2, orderCost, slippageCost, unrealized,
  PRESS_SIZE_USD, PRESS2, PRESS3, TARGET, GRID_STEP, LOSS_LEVELS,
  PRICE_TRAIL_PCT, cProfitTrailPct, press1Threshold, systemStop, pressPlan,
  protectivePolicy, partialProfitPolicy, isSystemHalted, D_MIN_FREE_USD,
  vectorExitThreshold, ruleKeyFor,
} from "./tickRules.js";
import { computeStockVector } from "./vectorCore.js";

// --- the 16:00 ET session end ------------------------------------------------
// EOD Position Close closes every open position at the bell. The engine is the
// executor once an account is Render's, so the same rule has to live here: without
// it a position Render owns would stay open past the close.
export const SESSION_CLOSE_MINUTE = 16 * 60;

const etClockFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

// Minute of the ET day (0-1439) for an instant, or 0 when it cannot be read.
export function etMinuteOfDay(iso) {
  try {
    const parts = etClockFmt.formatToParts(new Date(iso));
    const get = (t) => Number((parts.find((p) => p.type === t) || {}).value);
    const h = get("hour");
    const m = get("minute");
    if (!Number.isFinite(h) || !Number.isFinite(m)) return 0;
    return h * 60 + m;
  } catch (_) {
    return 0;
  }
}

// --- partialProfit.ts, reproduced exactly (banked profit is read from the sale
// --- entries themselves; there is no second copy of it anywhere). ----------------

export function bankedPartialGross(pos) {
  const entries = Array.isArray(pos?.partial_exits) ? pos.partial_exits : [];
  return r2(entries.reduce((a, e) => a + (Number(e?.gross_pl) || 0), 0));
}

export function partialAlreadyTaken(pos) {
  if (pos?.partial_profit_taken) return true;
  return Array.isArray(pos?.partial_exits) && pos.partial_exits.length > 0;
}

export function positionPl(pos, openPl) {
  return r2(bankedPartialGross(pos) + (Number(openPl) || 0));
}

export function positionPeak(pos, openPl) {
  return r2(Math.max(Number(pos?.peak_pl) || 0, positionPl(pos, openPl)));
}

export function positionGross(pos, side, exitPrice, shares, tcb) {
  return positionPl(pos, unrealized(side, exitPrice, shares, tcb));
}

// --- priceTrailingStop.ts assessPriceTrail -------------------------------------

export function assessPriceTrail(pos, currentPrice, pctOverride) {
  const active = !!pos.price_trail_active;
  if (!active) {
    return { active: false, breach: false, oldExtreme: null, newExtreme: null, protectedLevel: null, pct: null };
  }
  const side = pos.side;
  const raw = Number(pctOverride);
  const pct = Number.isFinite(raw) && raw > 0 ? Math.min(raw, PRICE_TRAIL_PCT) : PRICE_TRAIL_PCT;
  const oldExtreme = Number.isFinite(Number(pos.price_trail_extreme)) ? Number(pos.price_trail_extreme) : currentPrice;
  if (side === "long") {
    const newExtreme = Math.max(oldExtreme, currentPrice);
    const protectedLevel = r2(newExtreme * (1 - pct));
    return { active: true, breach: currentPrice <= protectedLevel, oldExtreme, newExtreme, protectedLevel, pct };
  }
  const newExtreme = Math.min(oldExtreme, currentPrice);
  const protectedLevel = r2(newExtreme * (1 + pct));
  return { active: true, breach: currentPrice >= protectedLevel, oldExtreme, newExtreme, protectedLevel, pct };
}

// --- partialProfit.ts planPartialProfit ---------------------------------------

export function planPartialProfit({ pos, system, side, price, shares, tcb, pl, policy, nowIso }) {
  if (!policy) return null;
  if (partialAlreadyTaken(pos)) return null;
  if (!(Number(pl) >= policy.threshold)) return null;
  if (!(Number(shares) > 0) || !(Number(tcb) > 0)) return null;

  const soldShares = Math.floor(shares * policy.fraction);
  const remaining = shares - soldShares;
  if (soldShares < 1 || remaining < 1) return null;

  const retention = remaining / shares;
  const soldCost = r2(tcb * (soldShares / shares));
  const proceeds = r2(soldShares * price);
  const gross = r2(side === "long" ? proceeds - soldCost : soldCost - proceeds);
  const fees = r2(orderCost(soldShares, price, side === "long") + slippageCost(soldShares, price));
  const net = r2(gross - fees);

  const tcbAfter = r2(tcb - soldCost);
  const remainingPl = r2(unrealized(side, price, remaining, tcbAfter));
  const banked = r2(bankedPartialGross(pos) + gross);
  const totalPl = r2(banked + remainingPl);
  const commissionFees = r2((Number(pos?.commission_fees) || 0) + fees);

  const entry = {
    timestamp: nowIso,
    shares: soldShares,
    price: r2(price),
    fraction: policy.fraction,
    threshold: policy.threshold,
    trigger_pl: r2(pl),
    gross_pl: gross,
    commission_fees: fees,
    net_pl: net,
    shares_before: shares,
    shares_after: remaining,
    tcb_before: r2(tcb),
    tcb_after: tcbAfter,
    reason: "partial_profit_exit",
  };

  const patch = {
    shares: remaining,
    tcb: tcbAfter,
    commission_fees: commissionFees,
    partial_profit_taken: true,
    partial_exits: [...(Array.isArray(pos?.partial_exits) ? pos.partial_exits : []), entry],
    current_price: r2(price),
    current_pl: totalPl,
    peak_pl: r2(Math.max(Number(pos?.peak_pl) || 0, totalPl)),
  };

  if (pos?.protective_stop_active) {
    const oldHigh = Number(pos?.protective_high_water_pl);
    const high = Number.isFinite(oldHigh) ? oldHigh : Number(pl);
    patch.protective_high_water_pl = r2(remainingPl + retention * Math.max(0, high - Number(pl)));
  }

  if (pos?.profit_grid_active) {
    const level = Math.floor(remainingPl / 100) * 100;
    patch.last_profit_level = level;
    patch.next_up_profit_level = level + 100;
    patch.next_down_profit_level = level - 100;
  }

  return {
    threshold: policy.threshold,
    fraction: policy.fraction,
    sold_shares: soldShares,
    remaining_shares: remaining,
    gross_pl: gross,
    commission_fees: fees,
    net_pl: net,
    tcb_after: tcbAfter,
    remaining_pl: remainingPl,
    total_pl: totalPl,
    slippage_cost: slippageCost(soldShares, price),
    entry,
    patch,
  };
}

// --- exit construction (cloneTick.ts, every close path) -----------------------

function buildExit({ pos, side, price, shares, tcb, reason, nowIso, nowMs, pl, priorPatches, extraPatch }) {
  const isLong = side === "long";
  const exitPrice = r2(price);
  const gross = positionGross(pos, side, exitPrice, shares, tcb);
  const commissionFees = r2(
    (Number(pos.commission_fees) || 0) + orderCost(shares, exitPrice, isLong) + slippageCost(shares, exitPrice)
  );
  const net = r2(gross - commissionFees);
  const holding = pos.entry_time ? Math.round((nowMs - new Date(pos.entry_time).getTime()) / 60000) : null;
  const peakPl = positionPeak(pos, pl);

  const patch = {
    status: "closed",
    exit_time: nowIso,
    exit_price: exitPrice,
    exit_reason: reason,
    current_price: exitPrice,
    current_pl: gross,
    gross_pl: gross,
    commission_fees: commissionFees,
    net_pl: net,
    holding_minutes: holding,
    peak_pl: r2(peakPl),
    ...(extraPatch || {}),
  };

  return {
    action: "exit",
    event: reason,
    exit_reason: reason,
    exit_price: exitPrice,
    exit_price_slipped: exitPrice,
    gross_pl: gross,
    commission_fees: commissionFees,
    net_pl: net,
    holding_minutes: holding,
    peak_pl: r2(peakPl),
    prior_patches: priorPatches,
    patch,
  };
}

// --- THE DECISION -------------------------------------------------------------

export function decideTick(args) {
  const { system, position: pos, nowIso } = args || {};
  const sys = String(system ?? "").trim().toUpperCase();
  const price = Number(args?.price);
  // Vector score: given, else computed from candles at the last bar (cloneTick.ts's
  // own index), else the live zero fallback when explicitly requested.
  const candles = Array.isArray(args?.candles) ? args.candles : null;
  const givenScore = args?.vectorScore == null ? null : Number(args.vectorScore);
  let vectorScore = givenScore != null && Number.isFinite(givenScore) ? givenScore : null;
  let vectorSource = vectorScore != null ? "given" : null;
  if (vectorScore == null && candles && candles.length > 0) {
    const idx = Number.isInteger(args?.candleIndex) ? args.candleIndex : candles.length - 1;
    const computed = computeStockVector(candles, idx, pos?.side, Number(pos?.entry_price));
    if (computed != null) {
      vectorScore = Number(computed.combined_reversal_score);
      vectorSource = "candles";
    }
  }
  if (vectorScore == null && args?.liveZeroFallback === true) {
    vectorScore = 0;
    vectorSource = "live_zero_fallback";
  }

  const base = {
    system: sys,
    symbol: pos?.symbol ?? null,
    price: Number.isFinite(price) ? price : null,
    vector_source: vectorSource,
  };

  if (!Number.isFinite(price) || price <= 0) {
    return { ...base, action: "invalid", reason: "invalid_price" };
  }
  const halted = args?.halted === undefined ? isSystemHalted(sys) : !!args.halted;
  if (halted) {
    return { ...base, action: "halted", reason: "trading_halted", halted: true };
  }
  if (!pos) {
    return { ...base, action: "skipped", reason: "position_not_found" };
  }
  if (pos.status === "closed") {
    return { ...base, action: "skipped", reason: "already_closed" };
  }

  // THE RULE KEY FOR THIS POSITION. The system's own row, except that a DART C
  // position opened before its 2026-11-13 10:45 AM ET cutover reads C_LEGACY, so it
  // keeps the rules it was opened under until it closes (see tickRules.ruleKeyFor).
  // Only the three rules that changed for C resolve through it; the presses, Profit
  // Protection, the +$2,000 auto-arm and the trail are C's own either way.
  const ruleKey = ruleKeyFor(sys, pos);

  const side = pos.side;
  const shares = Number(pos.shares) || 0;
  const tcb = Number(pos.tcb) || 0;
  const nowMs = Date.parse(nowIso);

  // Rule 1 — exact total-position P&L at the live price (raw, not rounded: every
  // comparison below uses this same unrounded figure, as cloneTick.ts does).
  const pl = unrealized(side, price, shares, tcb);

  const protectiveActive = !!pos.protective_stop_active;
  const oldHigh =
    protectiveActive && Number.isFinite(Number(pos.protective_high_water_pl))
      ? Number(pos.protective_high_water_pl)
      : null;
  const protectiveBuffer = protectivePolicy(ruleKey).buffer;
  const protectiveBreach = oldHigh != null && pl <= oldHigh - protectiveBuffer;

  const peakForTrail = Math.max(Number(pos.peak_pl) || 0, pl);
  const tierPct = cProfitTrailPct(peakForTrail);
  let pt = assessPriceTrail(pos, price, tierPct);

  const priorPatches = [];

  // Press 2 activated the trail: the write happens on this tick, before any stop is
  // evaluated, and can never itself breach.
  if (!pt.active && pos.pressed_2r) {
    priorPatches.push({
      price_trail_active: true,
      price_trail_extreme: r2(price),
      price_trail_activated_time: nowIso,
    });
    pt = {
      active: true,
      breach: false,
      oldExtreme: price,
      newExtreme: price,
      protectedLevel: null,
      pct: tierPct == null ? PRICE_TRAIL_PCT : tierPct,
    };
  }
  const priceTrailBreach = !!(pt.active && pt.breach);

  // Rule 2 — TERMINAL stop. Precedence is cloneTick.ts's exact order.
  const hardStop = systemStop(ruleKey);
  if (pl <= hardStop || protectiveBreach || priceTrailBreach) {
    const reason = pl <= hardStop ? "realtime_stop_close" : priceTrailBreach ? "price_trail_stop" : "protective_stop";
    return {
      ...base,
      ...buildExit({ pos, side, price, shares, tcb, reason, nowIso, nowMs, pl, priorPatches }),
      pl_raw: pl,
      stop_detail: {
        hard_stop: hardStop,
        protective_high_water: oldHigh,
        protective_buffer: protectiveBuffer,
        protective_breach: protectiveBreach,
        trail_pct: pt.active ? pt.pct : null,
        trail_protected: pt.active ? pt.protectedLevel : null,
        trail_breach: priceTrailBreach,
      },
    };
  }

  // Rule 2b — the 16:00 ET session end. Checked after the stops so a genuine stop
  // at the bell keeps its own reason, exactly as the live manager's close does.
  if (etMinuteOfDay(nowIso) >= SESSION_CLOSE_MINUTE) {
    return {
      ...base,
      ...buildExit({ pos, side, price, shares, tcb, reason: "close_1600", nowIso, nowMs, pl, priorPatches }),
      pl_raw: pl,
      session_close: true,
    };
  }

  // Rule 3 — protective high-water ratchet (a new high, no breach).
  if (protectiveActive && oldHigh != null && pl > oldHigh) {
    priorPatches.push({ protective_high_water_pl: r2(pl) });
  }

  // Rule 4 — price-trail extreme ratchet.
  if (pt.active && pt.newExtreme !== pt.oldExtreme) {
    priorPatches.push({ price_trail_extreme: r2(pt.newExtreme) });
  }

  // Rule 5 — partial profit-taking.
  const partial = planPartialProfit({
    pos, system: sys, side, price, shares, tcb, pl,
    policy: partialProfitPolicy(sys), nowIso,
  });
  if (partial) {
    return {
      ...base,
      action: "partial",
      event: "partial_profit_exit",
      pl_raw: pl,
      threshold: partial.threshold,
      fraction: partial.fraction,
      sold_shares: partial.sold_shares,
      remaining_shares: partial.remaining_shares,
      gross_pl: partial.gross_pl,
      commission_fees: partial.commission_fees,
      net_pl: partial.net_pl,
      prior_patches: priorPatches,
      patch: partial.patch,
      partial_entry: partial.entry,
    };
  }

  // Rule 6 — downside Vector 65 across newly crossed loss checkpoints.
  if (pl < 0) {
    const checked = new Set((pos.checked_loss_levels || []).map(Number));
    const newLevels = LOSS_LEVELS.filter((L) => !checked.has(L) && pl <= L);
    if (newLevels.length > 0) {
      if (vectorScore == null || !Number.isFinite(vectorScore)) {
        return {
          ...base,
          action: "needs_vector",
          pending_step: "downside_vector",
          loss_levels: newLevels,
          pl_raw: pl,
          prior_patches: priorPatches,
        };
      }
      const checkpoints = [...(pos.vector_checkpoints || [])];
      let exitVec = false;
      let vecLevel = 0;
      // The position's own exit threshold: the shared 65, or 45 for a C position
      // opened before its 2026-11-13 cutover (tickRules.vectorExitThreshold).
      const vecExit = vectorExitThreshold(ruleKey);

      for (const L of newLevels) {
        checked.add(L);
        const decision = vectorScore >= vecExit ? "EXIT" : "HOLD";
        checkpoints.push({
          loss_checkpoint: L,
          pl: r2(pl),
          time: nowIso,
          price: r2(price),
          press_count: (pos.pressed_1r ? 1 : 0) + (pos.pressed_2r ? 1 : 0) + (pos.pressed_3r ? 1 : 0),
          shares,
          weighted_avg_cost: shares ? r2(tcb / shares) : null,
          combined_reversal_score: r2(vectorScore),
          threshold: vecExit,
          decision,
        });
        if (decision === "EXIT") {
          exitVec = true;
          vecLevel = L;
          break;
        }
      }

      if (exitVec) {
        return {
          ...base,
          ...buildExit({
            pos, side, price, shares, tcb, reason: "vector_exit", nowIso, nowMs, pl, priorPatches,
            extraPatch: { checked_loss_levels: [...checked], vector_checkpoints: checkpoints },
          }),
          pl_raw: pl,
          vector_score: r2(vectorScore),
          vector_level: vecLevel,
        };
      }

      return {
        ...base,
        action: "hold",
        event: "vector_checkpoint_hold",
        pl_raw: pl,
        vector_score: r2(vectorScore),
        prior_patches: priorPatches,
        patch: {
          checked_loss_levels: [...checked],
          vector_checkpoints: checkpoints,
          current_price: r2(price),
          current_pl: positionPl(pos, pl),
          peak_pl: positionPeak(pos, pl),
        },
      };
    }
  }

  // Rule 7 — upside Vector grid (stateful ±$100 from +$900).
  let upsideLevel = null;
  if (pos.profit_grid_active) {
    const nextUp = Number(pos.next_up_profit_level);
    const nextDown = Number(pos.next_down_profit_level);
    if (pl >= nextUp || pl <= nextDown) {
      upsideLevel = pl >= nextUp ? nextUp : nextDown;
    }
  } else if (pl >= TARGET) {
    upsideLevel = TARGET;
  }

  if (upsideLevel != null) {
    if (vectorScore == null || !Number.isFinite(vectorScore)) {
      return {
        ...base,
        action: "needs_vector",
        pending_step: "upside_grid",
        grid_level: upsideLevel,
        pl_raw: pl,
        prior_patches: priorPatches,
      };
    }
    const isActivation = !pos.profit_grid_active;
    const vecExit = vectorExitThreshold(ruleKey);
    const decision = vectorScore >= vecExit ? "EXIT" : "HOLD";
    const profitCheckpoints = [...(pos.profit_checkpoints || [])];
    profitCheckpoints.push({
      profit_checkpoint: upsideLevel,
      pl: r2(pl),
      time: nowIso,
      price: r2(price),
      press_count: (pos.pressed_1r ? 1 : 0) + (pos.pressed_2r ? 1 : 0) + (pos.pressed_3r ? 1 : 0),
      shares,
      weighted_avg_cost: shares ? r2(tcb / shares) : null,
      combined_reversal_score: r2(vectorScore),
      threshold: vecExit,
      decision,
    });

    if (decision === "EXIT") {
      return {
        ...base,
        ...buildExit({
          pos, side, price, shares, tcb, reason: "vector_profit_exit", nowIso, nowMs, pl, priorPatches,
          extraPatch: { profit_checkpoints: profitCheckpoints },
        }),
        pl_raw: pl,
        vector_score: r2(vectorScore),
        vector_level: upsideLevel,
      };
    }

    return {
      ...base,
      action: "grid",
      event: isActivation ? "vector_profit_activate" : "vector_profit_hold",
      pl_raw: pl,
      vector_score: r2(vectorScore),
      grid_level: upsideLevel,
      next_up: upsideLevel + GRID_STEP,
      next_down: upsideLevel - GRID_STEP,
      prior_patches: priorPatches,
      patch: {
        profit_grid_active: true,
        last_profit_level: upsideLevel,
        next_up_profit_level: upsideLevel + GRID_STEP,
        next_down_profit_level: upsideLevel - GRID_STEP,
        profit_checkpoints: profitCheckpoints,
        current_price: r2(price),
        current_pl: positionPl(pos, pl),
        peak_pl: positionPeak(pos, pl),
      },
    };
  }

  // Rule 8 — presses. Precedence 3R, then 2R, then 1R. A single-press system
  // (DART D) has no 2R and no 3R at all: its Press 1 is the whole ladder.
  const plan = pressPlan(sys);
  const single = plan?.single === true;
  const press1Level = press1Threshold(sys);
  const wantPress3 = !single && pl >= PRESS3 && !!pos.pressed_1r && !!pos.pressed_2r && !pos.pressed_3r;
  const wantPress2 = !single && pl >= PRESS2 && !!pos.pressed_1r && !pos.pressed_2r;
  const wantPress1 = pl >= press1Level && !pos.pressed_1r;

  if (wantPress3 || wantPress2 || wantPress1) {
    const isPress3 = wantPress3;
    const isPress2 = wantPress2;

    // THE PRESS SIZE. A fixed-size system presses PRESS_SIZE_USD. A dynamically sized
    // one (DART D) presses what its caller measured against the day's buying power, so
    // the figure must arrive with the tick: with no measurement the step is never
    // guessed, and a known free balance under the floor is a SKIP, not a smaller press.
    let pressSizeUsd = PRESS_SIZE_USD;
    if (plan?.dynamicSize === true) {
      const sized = Number(args?.pressSizeUsd);
      if (!Number.isFinite(sized) || sized <= 0) {
        const free = args?.pressBudgetFree == null ? null : Number(args.pressBudgetFree);
        if (Number.isFinite(free)) {
          return {
            ...base,
            action: "skipped",
            reason: "press_budget_floor",
            pl_raw: pl,
            press_budget_free: r2(free),
            min_free: D_MIN_FREE_USD,
            prior_patches: priorPatches,
          };
        }
        return {
          ...base,
          action: "needs_budget",
          reason: "press_budget_unknown",
          pl_raw: pl,
          prior_patches: priorPatches,
        };
      }
      pressSizeUsd = sized;
    }

    const addShares = Math.floor(pressSizeUsd / price);
    if (addShares <= 0) {
      return {
        ...base,
        action: "skipped",
        reason: "press_shares_zero",
        pl_raw: pl,
        prior_patches: priorPatches,
      };
    }
    const isLong = side === "long";
    const addCost = r2(addShares * price);
    const newShares = shares + addShares;
    const newTcb = r2(tcb + addCost);
    const pressSlip = slippageCost(addShares, price);
    const commissionFees = r2(
      (Number(pos.commission_fees) || 0) + orderCost(addShares, price, !isLong) + pressSlip
    );
    const newPressed2 = isPress2 || isPress3;
    const pressLevel = isPress3 ? "3R" : isPress2 ? "2R" : "1R";
    // The share-price trail starts at Press 2, or — on a single-press system — at its
    // one and only press.
    const activatesTrail = isPress2 || (plan?.trailAtFirstPress === true && !isPress2 && !isPress3);
    const pressEntry = {
      timestamp: nowIso,
      level: pressLevel,
      shares_added: addShares,
      price_added: r2(price),
    };

    return {
      ...base,
      action: "press",
      event: isPress3 ? "press3" : isPress2 ? "press2" : "press1",
      pl_raw: pl,
      press_level: pressLevel,
      press_size_usd: pressSizeUsd,
      shares_added: addShares,
      price_added: r2(price),
      shares_after: newShares,
      weighted_avg_cost: r2(newTcb / newShares),
      commission_fees: commissionFees,
      slippage_cost: pressSlip,
      prior_patches: priorPatches,
      patch: {
        shares: newShares,
        tcb: newTcb,
        pressed_1r: true,
        pressed_2r: newPressed2,
        pressed_3r: isPress3,
        presses: [...(Array.isArray(pos.presses) ? pos.presses : []), pressEntry],
        current_price: r2(price),
        current_pl: positionPl(pos, unrealized(side, price, newShares, newTcb)),
        peak_pl: positionPeak(pos, pl),
        commission_fees: commissionFees,
        ...(activatesTrail
          ? { price_trail_active: true, price_trail_extreme: r2(price), price_trail_activated_time: nowIso }
          : {}),
      },
    };
  }

  // Rule 9 — hold. Display-only marks, exactly as the live hold path writes.
  return {
    ...base,
    action: "hold",
    event: "hold",
    pl_raw: pl,
    trail_pct: pt.active ? pt.pct : null,
    trail_protected: pt.active ? pt.protectedLevel : null,
    prior_patches: priorPatches,
    patch: {
      current_price: r2(price),
      current_pl: positionPl(pos, pl),
      peak_pl: positionPeak(pos, pl),
    },
  };
}