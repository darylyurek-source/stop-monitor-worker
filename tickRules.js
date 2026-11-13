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
// DART D is B's rule set plus ONE change — a single Press instead of B's three — and
// that press fires at B's own Press 1 level, +$250 (2026-11-10, before the fresh
// test). Its SIZE is the difference, not its trigger: see PRESS_PLAN below. Every
// system here presses at +$250.
export const CLONE_PRESS1 = {
  B: 250,
  C: 250,
  D: 250,
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
// DART D (2026-11-08, retuned 2026-11-10) is the one exception: ONE press, at +$250,
// sized at the moment it fires from D's own daily buying power, and the share-price
// trailing stop starts at that press instead of at a Press 2 that no longer exists.
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

// ---------------------------------------------------------------------------
// DART C — NO CUTOVER. The planned change that would have made C an exact copy of
// DART A's rules was CANCELLED on 2026-11-13 at 10:50 AM ET, before it could run, so
// C keeps the rule set it trades today, permanently and with no date attached:
// Protective Stop 45/85, Vector Exit 45, Profit Protection 25%
// at +$1,850, the +$2,000 Automatic Hard Stop with its $350 giveback, B's three
// presses, the trailing-stop ladder and the 4:00 PM close. Every C position — the
// ones it holds now and every one it opens from here — resolves to C_LEGACY.
//
// C'S HARD LOSS STOP MOVED TO -$1,200 at 1:44:55 PM ET, Friday 2026-11-13, mid-session,
// on the owner's direction; it was -$100. The level is read from SYSTEM_HARD_STOP on
// every tick, so the C positions already open at that moment carry the new stop from
// their next print — no record is rewritten. Nothing else on C, and nothing on A, B
// or D, changed.
//
// The C rows in the tables below are kept ONLY so that a caller naming the account
// ("C") resolves to those same numbers instead of a fallback. No rule key can reach
// any other C row any more.
// ---------------------------------------------------------------------------
export function ruleKeyFor(system, position) {
  const s = String(system ?? "").trim().toUpperCase();
  return s === "C" ? "C_LEGACY" : s;
}

// cloneSystems.ts — per-system hard-loss stop. A -$1,200, B -$1,200, C -$1,200,
// D -$1,200. C's row was -$100 until 1:44:55 PM ET on 2026-11-13, when the owner
// moved it to -$1,200 mid-session; the cancelled cutover to A's rules is what had
// kept it at -$100, and C_LEGACY is still the only C row a position can resolve to
// (the "C" alias carries the same number). A's row was -$200 until 14:00:38 PM ET on
// 2026-11-13, when the owner moved it to -$1,200 mid-session, open positions
// included. The shared STOP below is only
// the fallback for a system
// that is not listed (a legacy record such as DART A's old 'A' alias). It is the
// same table Base44 resolves, so the two engines cannot part company on it.
export const SYSTEM_HARD_STOP = { ANEW: -1200, B: -1200, C: -1200, C_LEGACY: -1200, D: -1200 };

export function systemStop(system) {
  const v = SYSTEM_HARD_STOP[String(system ?? "").trim().toUpperCase()];
  return Number.isFinite(Number(v)) ? Number(v) : STOP;
}

// cloneSystems.ts — partial profit-taking. DART B's row was ADDED on 2026-11-10, before
// the open, at the owner's direction — 25% of the position, once, at +$1,850. DART A
// (ANEW) carries the same row: A is B plus the 5-minute delay, so it carries B's Profit
// Protection too. It is the same number Base44 resolves, so the two engines cannot part
// company on it.
// DART C's row was REMOVED on 2026-11-06 (before the open): C runs B's rules with no
// partial sale at all.
// DART D's row was ADDED on 2026-11-10, before the fresh test: D is B's rule set plus
// ONE change — a single Press — so it carries B's Profit Protection and sells 25% once
// per position at +$1,850, exactly as B does. E was removed from the engine on
// 2026-11-10, so it has no row here.
export const SYSTEM_PARTIAL_PROFIT = {
  B: { threshold: 1850, fraction: 0.25 }, // DART B — the standard, from 2026-11-10
  ANEW: { threshold: 1850, fraction: 0.25 }, // DART A — B plus the 5-minute delay
  D: { threshold: 1850, fraction: 0.25 }, // DART D — B plus one single, buying-power-sized Press
  // DART C (set 2026-11-11, after that day's close): C runs B's rules EXACTLY from
  // the next session, so it carries B's Profit Protection — 25% once at +$1,850.
  // The row removed on 2026-11-06 is restored; its one remaining difference from B
  // is now the Vector test below (C's own arming thresholds and its own Vector Exit).
  C: { threshold: 1850, fraction: 0.25 },
};

// THE +$2,000 AUTO-ARM — carried by DART B (from 2026-11-09), DART A (ANEW, same date),
// DART D (B's rule set from 2026-11-08) and DART C (restored 2026-11-10, at the owner's
// direction: C is B's rule set with ONE difference only — no profit-protection sale —
// so it arms exactly as B does). E was removed from the engine on 2026-11-10.
//
// The rule: once a position's P&L reaches +$2,000 the protective stop arms
// automatically — no Vector test — and gives back whatever its own system's row
// below holds ($350 for A, B and C, $700 for D from 2026-11-11). Below +$2,000 the
// Vector test is unchanged, so a position can still arm earlier on deterioration.
export const AUTO_ARM_PL_BY_SYSTEM = {
  B: 2000,
  ANEW: 2000,
  D: 2000,
  C: 2000, // 2026-11-10: C matches B everywhere except its absent profit-protection sale
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
//   C_RULE_SET  stock 65 / market 86 — the retired clones (no live system uses it)
// Both give back $350. An unknown system resolves to C_RULE_SET, exactly as
// protectivePolicy() does in Base44.
// ---------------------------------------------------------------------------
export const B_RULE_SET = { stockThreshold: 55, marketThreshold: 65, buffer: 350 };
export const C_RULE_SET = { stockThreshold: 65, marketThreshold: 86, buffer: 350 };

// DART D's own row (2026-11-11): B's 55/65 arming with D's stops at double size —
// a $700 giveback (was $350). Nothing else about D changed; it is still B's rule
// set plus its single buying-power-sized Press.
const D_RULE_SET = { stockThreshold: 55, marketThreshold: 65, buffer: 700 };

// DART C's Vector test (2026-11-11, after that day's close — and now PERMANENT,
// because the cutover that would have moved C to A's 55/65 was cancelled on
// 2026-11-13): stock 45 / market 85 with the same $350 giveback, chosen by the
// extended Vector sweep. C_LEGACY is the only C row in force; the "C" alias below
// resolves to the same numbers. These are the identical numbers the Base44 copy
// holds (shared/protectiveStop.ts).
export const C_STOCK_ARM = 45;
export const C_MARKET_ARM = 85;

export const C_LEGACY_STOCK_ARM = 45;
export const C_LEGACY_MARKET_ARM = 85;

const C_LEGACY_RULE_SET = {
  stockThreshold: C_LEGACY_STOCK_ARM,
  marketThreshold: C_LEGACY_MARKET_ARM,
  buffer: 350,
};

export const PROTECTIVE_BY_SYSTEM = {
  ANEW: B_RULE_SET,
  B: B_RULE_SET,
  // DART C — its own 45/85, permanently (the cutover to A's 55/65 was cancelled).
  // The "C" alias carries the same numbers as C_LEGACY, so no caller can land on a
  // different C rule set.
  C: C_LEGACY_RULE_SET,
  C_LEGACY: C_LEGACY_RULE_SET,
  // DART D arms at B's 55/65 and gives back $700 from 2026-11-11 (its stops were
  // doubled on D's own account; B, C and A keep $350).
  D: D_RULE_SET,
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

// DART C's Vector Exit (2026-11-11, now PERMANENT — the cutover to A's 65 was
// cancelled on 2026-11-13): C closes at 45 on every C position, the extended Vector
// sweep's choice. Every other account reads the shared VECTOR_THRESHOLD (65).
export const C_VECTOR_EXIT = 45;
export const C_LEGACY_VECTOR_EXIT = 45;

// Exported so a read-only study can sweep a system's exit threshold without touching
// the rule: the harness mutates this table in its own process, never in the worker.
export const VECTOR_EXIT_BY_SYSTEM = { C: C_VECTOR_EXIT, C_LEGACY: C_LEGACY_VECTOR_EXIT };

// The Vector Exit threshold a system closes at: its own row, else the shared 65.
export function vectorExitThreshold(system) {
  const v = VECTOR_EXIT_BY_SYSTEM[String(system ?? "").trim().toUpperCase()];
  return Number.isFinite(Number(v)) ? Number(v) : VECTOR_THRESHOLD;
}

export const LOSS_LEVELS = [
  -100, -200, -300, -400, -500, -600, -700, -800, -900,
  -1000, -1100, -1200, -1300, -1400, -1500, -1600, -1700,
];

// ---------------------------------------------------------------------------
// systemHalt.ts — NO account is halted. C was reactivated 2026-11-01 and D on
// 2026-11-10, before the fresh test that opens Nov 11: A, B, C and D all trade. A
// halted account trades nothing — the engine returns a no-op decision and writes
// nothing — so this list is the one lever that stops an account dead, and it is empty.
// E was removed from the engine on 2026-11-10.
// This list must always be kept in step with shared/systemHalt.ts on the Base44
// side — the engine holds its own copy so a tick never depends on a network read.
// ---------------------------------------------------------------------------
export const HALTED_SYSTEMS = [];

const HALTED = new Set(HALTED_SYSTEMS.map((s) => String(s).trim().toUpperCase()));

export function isSystemHalted(system) {
  return HALTED.has(String(system ?? "").trim().toUpperCase());
}