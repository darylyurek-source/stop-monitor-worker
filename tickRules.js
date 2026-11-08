// tickRules.js — THE FROZEN RULE SET for the Render tick-decision engine.
//
// Every constant here is a verbatim copy of ONE Base44 value, and the comment above
// it names the file it came from. Nothing else in the Render engine may declare a
// trading number: if a value belongs to a rule, it lives here, so a drift check
// compares this file against Base44 and finds it in one place.
//
// Sources (2026-11-01):
//   shared/liveTradeMath.ts        PRESS_SIZE_USD, PRESS2, PRESS3, TARGET, STOP,
//                                  the IBKR Canada tiered cost model, slippage, r2
//   shared/cloneSystems.ts         CLONE_PRESS1, SYSTEM_HARD_STOP,
//                                  SYSTEM_PARTIAL_PROFIT
//   shared/protectiveStop.ts       the three rule sets and the per-system table
//   shared/priceTrailingStop.ts    PRICE_TRAIL_PCT, C_PROFIT_TRAIL_TIERS
//   shared/trendReversalVector.ts  LOSS_LEVELS
//   shared/cloneTick.ts            VECTOR_THRESHOLD (THRESHOLD = 65)
//   shared/systemHalt.ts           HALTED_SYSTEMS
//
// NO trading state, no I/O, no clock. Pure data plus pure helpers.

// ---------------------------------------------------------------------------
// liveTradeMath.ts
// ---------------------------------------------------------------------------
export const PRESS_SIZE_USD = 40000;
export const PRESS2 = 700;
export const PRESS3 = 800;
export const TARGET = 900;
export const STOP = -1700;
// The upside grid's step (cloneTick.ts evaluates last_profit_level ± 100).
export const GRID_STEP = 100;

const COMM_PER_SHARE = 0.0035;
const COMM_MIN = 0.35;
const COMM_MAX_PCT = 0.01;
const SEC_FEE_RATE = 0.0000278;
const FINRA_TAF_PER_SHARE = 0.000166;
const FINRA_TAF_MAX = 8.3;
const EXCHANGE_CLEARING_PER_SHARE = 0.0002;

export const SLIPPAGE_RATE = 0.0001;

export const r2 = (v) => Math.round((Number(v) + Number.EPSILON) * 100) / 100;

export function slippageCost(shares, price) {
  return r2(shares * price * SLIPPAGE_RATE);
}

export function orderCost(shares, price, isSell) {
  const notional = shares * price;
  const commission = Math.min(Math.max(COMM_PER_SHARE * shares, COMM_MIN), COMM_MAX_PCT * notional);
  const sec = isSell ? SEC_FEE_RATE * notional : 0;
  const finra = isSell ? Math.min(FINRA_TAF_PER_SHARE * shares, FINRA_TAF_MAX) : 0;
  const exchClear = EXCHANGE_CLEARING_PER_SHARE * shares;
  return r2(commission + sec + finra + exchClear);
}

export function unrealized(side, currentPrice, shares, totalCostBasis) {
  if (side === "long") return currentPrice * shares - totalCostBasis;
  return totalCostBasis - currentPrice * shares;
}

// ---------------------------------------------------------------------------
// cloneSystems.ts — Press 1 is the ONE setting that differs per system.
// ---------------------------------------------------------------------------
// DART D was rebuilt as an exact copy of DART B on 2026-11-08 and presses ONCE, at
// +$150 (see PRESS_PLAN below). Every other system keeps +$250.
export const CLONE_PRESS1 = {
  B: 250,
  C: 250,
  D: 150,
  E: 250,
  ANEW: 250,
};

export function press1Threshold(system) {
  const v = CLONE_PRESS1[String(system ?? "").trim().toUpperCase()];
  if (Number.isFinite(Number(v))) return Number(v);
  const c = CLONE_PRESS1.C;
  return Number.isFinite(Number(c)) ? Number(c) : 250;
}

// ---------------------------------------------------------------------------
// cloneSystems.ts — pressPlan(). WHICH PRESSES a system takes, and whether the
// share-price trail starts at the first one. A system with no row presses the shared
// three times (+$700, +$800 after its own Press 1) at the fixed $40,000.
//
// DART D (2026-11-08) is the one exception: ONE press, at +$150, sized at the moment
// it fires from D's own daily buying power, and the share-price trailing stop starts
// at that press instead of at a Press 2 that no longer exists.
// ---------------------------------------------------------------------------
export const PRESS_PLAN = {
  D: { single: true, dynamicSize: true, trailAtFirstPress: true },
};

export function pressPlan(system) {
  return PRESS_PLAN[String(system ?? "").trim().toUpperCase()] || null;
}

// ---------------------------------------------------------------------------
// dPressBudget.ts — D's buying power, and the size of its one press.
//   buying power = 3 x D's account value, fixed each morning for the session,
//   each press   = $120,000 or the buying power still free, whichever is smaller,
//   below $20,000 free the press is SKIPPED (never scaled down further).
// The buying power itself is read from Base44's daily DPressBudget row (the worker
// caches it at sync); what is free is that figure less the cost basis of every open
// D position in the book, so no per-tick read is needed.
// ---------------------------------------------------------------------------
export const D_BUYING_POWER_MULTIPLE = 3;
export const D_MAX_PRESS_USD = 120000;
export const D_MIN_FREE_USD = 20000;

export function buyingPowerFor(equity) {
  const e = Number(equity);
  if (!Number.isFinite(e)) return 0;
  return r2(Math.max(0, e) * D_BUYING_POWER_MULTIPLE);
}

// Buying power still free, or null when the day's figure is not known.
export function freeBuyingPower(buyingPower, deployed) {
  const bp = Number(buyingPower);
  if (!Number.isFinite(bp)) return null;
  return r2(Math.max(0, bp - (Number(deployed) || 0)));
}

// The size of one press given the buying power still free, or null when there is not
// enough free to press at all (the press is skipped).
export function dPressSizeFor(free) {
  const f = Number(free);
  if (!Number.isFinite(f) || f < D_MIN_FREE_USD) return null;
  return Math.floor(Math.min(D_MAX_PRESS_USD, f));
}

// cloneSystems.ts — no system overrides the shared -$1,700 stop (DART A+ carried
// the last override and is retired).
export const SYSTEM_HARD_STOP = {};

export function systemStop(system) {
  const v = SYSTEM_HARD_STOP[String(system ?? "").trim().toUpperCase()];
  return Number.isFinite(Number(v)) ? Number(v) : STOP;
}

// cloneSystems.ts — partial profit-taking. A and B have NO row and therefore never
// sell partially: one comparison, no-op.
// DART C's row was REMOVED on 2026-11-06 (before the open): C runs B's rules with no
// partial sale at all.
// DART D's row was REMOVED on 2026-11-08 when D was rebuilt as an exact copy of B: D
// never sells partially and holds every position to its own exits. E keeps its row
// (+$1,500, 50%) because E is D's copy of 2026-10-30 and is halted.
export const SYSTEM_PARTIAL_PROFIT = {
  E: { threshold: 1500, fraction: 0.5 },
};

// THE +$2,000 AUTO-ARM — DART B's rule from 2026-11-09, before that Monday's open,
// and DART A's (ANEW) from the same date at the owner's direction. It was DART C's
// from 2026-11-06 and was MOVED to B on 2026-11-07, which makes C the control: C arms
// on the Vector test only, at B's original 55/65. Nothing else changed anywhere.
//
// The rule: once a position's P&L reaches +$2,000 the $350 protective stop arms
// automatically — no Vector test. Below +$2,000 the Vector test is unchanged, so a
// position can still arm earlier on deterioration. A, B and D have the row (identical,
// +$2,000 — D carries B's whole rule set from 2026-11-08); C and E have none and their
// single comparison is a no-op.
export const AUTO_ARM_PL_BY_SYSTEM = {
  B: 2000,
  ANEW: 2000,
  D: 2000,
};

export function autoArmPolicy(system) {
  const v = AUTO_ARM_PL_BY_SYSTEM[String(system ?? "").trim().toUpperCase()];
  return Number.isFinite(Number(v)) ? Number(v) : null;
}

export function partialProfitPolicy(system) {
  const v = SYSTEM_PARTIAL_PROFIT[String(system ?? "").trim().toUpperCase()];
  if (!v) return null;
  const threshold = Number(v.threshold);
  const fraction = Number(v.fraction);
  if (!Number.isFinite(threshold) || !Number.isFinite(fraction)) return null;
  if (!(fraction > 0) || !(fraction < 1)) return null;
  return { threshold, fraction };
}

// ---------------------------------------------------------------------------
// protectiveStop.ts — arm thresholds and the giveback.
//   B_RULE_SET  stock 55 / market 65 — DART A (ANEW), DART B and DART C. C arms
//              on the Vector test only; A and B (from 2026-11-09) also arm at +$2,000
//   CD_RULE_SET stock 65 / market 85 — DART E (halted; D moved to B's set 2026-11-08)
//   C_RULE_SET  stock 65 / market 86 — the retired clones (no live system uses it)
// All three give back $350. An unknown system resolves to C_RULE_SET, exactly as
// protectivePolicy() does in Base44.
// ---------------------------------------------------------------------------
export const B_RULE_SET = { stockThreshold: 55, marketThreshold: 65, buffer: 350 };
export const CD_RULE_SET = { stockThreshold: 65, marketThreshold: 85, buffer: 350 };
export const C_RULE_SET = { stockThreshold: 65, marketThreshold: 86, buffer: 350 };

export const PROTECTIVE_BY_SYSTEM = {
  ANEW: B_RULE_SET,
  B: B_RULE_SET,
  // DART C moved to B's 55/65 on 2026-11-06 and lost the +$2,000 auto-arm on
  // 2026-11-09: C now runs B's ORIGINAL rule set exactly — the Vector test only —
  // and is the control B is measured against.
  C: B_RULE_SET,
  // DART D was rebuilt as an exact copy of DART B on 2026-11-08 and moved from its
  // own 65/85 row to B's 55/65 set. D is halted.
  D: B_RULE_SET,
  // DART E is D's copy of 2026-10-30 and keeps its own 65/85 row. E is halted.
  E: CD_RULE_SET,
  // Legacy A alias, no longer routed. Kept so a historical 'A' record still
  // resolves to the same 55/65 rule set it always had — never to the fallback.
  A: B_RULE_SET,
};

export function protectivePolicy(system) {
  return PROTECTIVE_BY_SYSTEM[String(system ?? "").trim().toUpperCase()] || C_RULE_SET;
}

// ---------------------------------------------------------------------------
// priceTrailingStop.ts — the share-price trail, driven by PEAK unrealized profit.
// ---------------------------------------------------------------------------
export const PRICE_TRAIL_PCT = 0.0175;

export const C_PROFIT_TRAIL_TIERS = [
  { min_peak_pl: 3500, pct: 0.0035 },
  { min_peak_pl: 2500, pct: 0.005 },
  { min_peak_pl: 2000, pct: 0.0075 },
  { min_peak_pl: 1500, pct: 0.01 },
  { min_peak_pl: 900, pct: 0.0175 },
];

export function cProfitTrailPct(peakPl) {
  const peak = Number(peakPl);
  if (!Number.isFinite(peak)) return null;
  for (const t of C_PROFIT_TRAIL_TIERS) if (peak >= t.min_peak_pl) return t.pct;
  return null;
}

// ---------------------------------------------------------------------------
// trendReversalVector.ts + cloneTick.ts — the Vector exit threshold and the loss
// checkpoints the downside Vector is evaluated at. Permanent: each level is
// checked once per position.
// ---------------------------------------------------------------------------
export const VECTOR_THRESHOLD = 65;

export const LOSS_LEVELS = [
  -100, -200, -300, -400, -500, -600, -700, -800, -900,
  -1000, -1100, -1200, -1300, -1400, -1500, -1600, -1700,
];

// ---------------------------------------------------------------------------
// systemHalt.ts — D and E are halted (C reactivated 2026-11-01). A halted account
// trades nothing: the engine returns a no-op decision and writes nothing.
// D is wired onto the Render engine ahead of its activation (2026-11-08): its
// switchboard row says engine render / mode live, and this halt outranks it, so the
// engine decides every one of D's ticks and the verdict is "halted" — no press, no
// exit, no write. Removing "D" here (shared/systemHalt.ts on the Base44 side) is the
// one change that turns the account on.
// ---------------------------------------------------------------------------
export const HALTED_SYSTEMS = ["D", "E"];

const HALTED = new Set(HALTED_SYSTEMS.map((s) => String(s).trim().toUpperCase()));

export function isSystemHalted(system) {
  return HALTED.has(String(system ?? "").trim().toUpperCase());
}