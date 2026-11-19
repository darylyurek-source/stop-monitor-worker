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
export const PRESS2 = 400;
export const PRESS3 = 1100;
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
// Press 1 is +$200 on every live system from 2026-11-18: A, B and C moved from +$250 to
// +$200 (the owner's press-level change), and D already fired there from the same session
// (its own STEP 6 row). D's difference from A is the SIZE and the number of rungs, not the
// trigger: see PRESS_PLAN below. E is the decommissioned account's leftover key and is
// never resolved by a live position.
export const CLONE_PRESS1 = {
  B: 200,
  C: 200,
  D: 200,
  E: 250,
  ANEW: 200,
};

export function press1Threshold(system) {
  const v = CLONE_PRESS1[String(system ?? "").trim().toUpperCase()];
  if (Number.isFinite(Number(v))) return Number(v);
  const c = CLONE_PRESS1.C;
  return Number.isFinite(Number(c)) ? Number(c) : 200;
}

// ---------------------------------------------------------------------------
// cloneSystems.ts — pressPlan(). WHICH PRESSES a system takes, and whether the
// share-price trail starts at the first one. A system with no row presses the shared
// three times (+$400, +$1,100 after its own Press 1) at the fixed $40,000.
//
// DART D (2026-11-08, retuned 2026-11-10, level +$200 from 2026-11-18) is the one
// exception: ONE press, at D's own level, sized at the moment it fires from D's own daily
// buying power ($120,000 or the free balance, skipped below $20,000 free). Its trail is the
// +$500 / $100 P&L giveback, never a press trail.
// ---------------------------------------------------------------------------
export const PRESS_PLAN = {
  D: { single: true, dynamicSize: true, trailAtFirstPress: false },
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
// DART C (2026-11-16, the owner's rule 9 as amended): C's Hard Loss Stop is -$400,
// decided on the two-print rule the price gate already enforces. C_LEGACY carries the
// same number — it is the only C row a position can resolve to. A, B and D are NOT
// changed.
export const SYSTEM_HARD_STOP = { ANEW: -1200, B: -1200, C: -400, C_LEGACY: -400, D: -400 };

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
  D: { threshold: 850, fraction: 0.25 }, // DART D (2026-11-16): C's rule set — 25% once at +$850
  // DART C (set 2026-11-11, after that day's close): C runs B's rules EXACTLY from
  // the next session, so it carries B's Profit Protection — 25% once at +$1,850.
  // The row removed on 2026-11-06 is restored; its one remaining difference from B
  // is now the Vector test below (C's own arming thresholds and its own Vector Exit).
  // DART C (2026-11-15, the owner's rule 6): 25% once at +$850, not +$1,850.
  C: { threshold: 850, fraction: 0.25 },
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
  D: 1000, // DART D (2026-11-16): +$1,000 — C's rule set
  // DART C (2026-11-15, the owner's rule 8): +$1,000 — C's ONLY arming level, because
  // the Protective Stop was removed from C on the same day.
  C: 1000,
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
// DART D (2026-11-16): the Protective Stop is REMOVED from D, exactly as from C — the
// arming thresholds are 101/101, which no Vector score can reach. The row's only
// remaining job is the $250 the Automatic Hard Stop gives back once it arms at +$1,000.
const D_RULE_SET = { stockThreshold: 101, marketThreshold: 101, buffer: 250 };

// DART C's Vector test (2026-11-11, after that day's close — and now PERMANENT,
// because the cutover that would have moved C to A's 55/65 was cancelled on
// 2026-11-13): stock 45 / market 85 with the same $350 giveback, chosen by the
// extended Vector sweep. C_LEGACY is the only C row in force; the "C" alias below
// resolves to the same numbers. These are the identical numbers the Base44 copy
// holds (shared/protectiveStop.ts).
// DART C (2026-11-15, the owner's rule 9): THE PROTECTIVE STOP IS REMOVED FROM C, so
// these thresholds are deliberately unreachable — a Vector score runs 0-100 and 101 can
// never be met. Removing the arming this way leaves every code path A, B and D use
// exactly as it was.
export const C_STOCK_ARM = 101;
export const C_MARKET_ARM = 101;

export const C_LEGACY_STOCK_ARM = 101;
export const C_LEGACY_MARKET_ARM = 101;

// DART C's row now carries ONE job: the $250 the Automatic Hard Stop gives back from
// its high-water P&L once it arms at +$1,000 (AUTO_ARM_PL_BY_SYSTEM.C). The arming
// thresholds above can never be reached, so no Vector test can arm C.
const C_LEGACY_RULE_SET = {
  stockThreshold: C_LEGACY_STOCK_ARM,
  marketThreshold: C_LEGACY_MARKET_ARM,
  buffer: 250,
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

// DART C's ladder (2026-11-15, the owner's rule 7): from +$500 1.00%, from +$700
// 0.75%, from +$900 0.50%, from +$1,100 0.25%. Nothing below +$500 — and C's trail now
// ARMS at +$500 instead of at Press 2, so the first tier is the first trail.
export const C_PROFIT_TRAIL_TIERS = [
  { min_peak_pl: 1100, pct: 0.0025 },
  { min_peak_pl: 900, pct: 0.005 },
  { min_peak_pl: 700, pct: 0.0075 },
  { min_peak_pl: 500, pct: 0.01 },
];

export function cProfitTrailPct(peakPl) {
  const peak = Number(peakPl);
  if (!Number.isFinite(peak)) return null;
  for (const t of C_PROFIT_TRAIL_TIERS) if (peak >= t.min_peak_pl) return t.pct;
  return null;
}

// DART C (2026-11-16, the owner's rule 7 as amended): C's trail is a FIXED $100 DOLLAR
// GIVEBACK, not a percentage of price. It still ARMS at +$500 of peak P&L; once armed,
// C closes on the first valid print whose P&L is at or below the highest P&L reached
// since arming minus $100. The ladder above survives only for the read-only studies
// that replay old trades: no live C tick calls it.
export const C_TRAIL_ARM_PL = 500;
export const C_TRAIL_GIVEBACK_USD = 100;

// DART D (2026-11-16, the owner's rule 8): D carries the SAME P&L giveback trail as C —
// it arms when P&L first reaches +$500 (C_TRAIL_ARM_PL above) and closes on the first
// admissible print whose P&L is at or below the highest reached since arming minus $100.
// One table, so neither account can drift from the other; A and B have no row and keep
// the share-price percentage trail, unchanged.
export const TRAIL_GIVEBACK_BY_SYSTEM = { C: 100, C_LEGACY: 100, D: 100 };

// The giveback (USD) a system's trail enforces, or null when it has the price trail.
export function trailGivebackFor(system) {
  const v = TRAIL_GIVEBACK_BY_SYSTEM[String(system ?? "").trim().toUpperCase()];
  return Number.isFinite(Number(v)) ? Number(v) : null;
}

// ---------------------------------------------------------------------------
// The session end, per account. FROM THE 2026-11-19 SESSION EVERY ACCOUNT CLOSES AT
// 15:00 ET (the owner's trading-hours change): A, B, C and D each hold a row here, so
// nothing new is opened at or after 15:00 and everything still open is closed then,
// recorded as close_1500. Before this the four sat at the shared 16:00, except C and D
// which closed at 13:30; the minute is a table entry, so the change lives here and
// nowhere else. decideTick and the close sweep both read this one table, so a tick and
// the clock can never part company on it.
// ---------------------------------------------------------------------------
export const SYSTEM_CLOSE_MINUTE = {
  ANEW: 15 * 60 + 0,
  B: 15 * 60 + 0,
  C: 15 * 60 + 0,
  C_LEGACY: 15 * 60 + 0,
  D: 15 * 60 + 0,
};

// TODAY ONLY — 2026-11-16 (owner authorized for this session alone). DART C and DART D
// do NOT close at 13:30 on this date: every open C and D position runs under its normal
// rules until it exits on its own, or at the shared 16:00 close. Entries are untouched —
// Base44's own 13:30 entry cutoff is a separate rule in a separate process and is not read
// here. THE EXCEPTION IS A DATE LITERAL, so it reverts by itself: on 2026-11-17 the date is
// no longer in these lists, this table is read exactly as it was before, and nothing has to
// be reverted, switched off or remembered.
export const FULL_SESSION_CLOSE_DATES = { C: ["2026-11-16"], C_LEGACY: ["2026-11-16"], D: ["2026-11-16"] };

// The ET calendar date of an instant, so the exception is keyed on the exchange's own day
// and never on the server's timezone.
function etDateOf(ms) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (t) => (parts.find((p) => p.type === t) || {}).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function systemCloseMinute(system, shared = 16 * 60, nowMs = null) {
  const key = String(system ?? "").trim().toUpperCase();
  const v = SYSTEM_CLOSE_MINUTE[key];
  if (!Number.isFinite(Number(v))) return shared;
  if (nowMs != null && (FULL_SESSION_CLOSE_DATES[key] || []).includes(etDateOf(nowMs))) return shared;
  return Number(v);
}

// The exit reason a scheduled close records: the minute decides it, so a 15:00 close is
// close_1500 and the record and the Exit Scorecard say 3:00, never 4:00.
export function closeReasonFor(system, shared = 16 * 60, nowMs = null) {
  const m = systemCloseMinute(system, shared, nowMs);
  if (m === shared) return "close_1600";
  return `close_${String(Math.floor(m / 60)).padStart(2, "0")}${String(m % 60).padStart(2, "0")}`;
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
// DART C (2026-11-15, the owner's answer 3): C HAS NO VECTOR EXIT OF ANY KIND. The
// threshold is unreachable (Vector is scored 0-100), which removes both the downside
// checkpoints and the +$900 upside grid for C without touching A, B or D's exit.
export const C_VECTOR_EXIT = 101;
export const C_LEGACY_VECTOR_EXIT = 101;

// Exported so a read-only study can sweep a system's exit threshold without touching
// the rule: the harness mutates this table in its own process, never in the worker.
// DART D (2026-11-16): D HAS NO VECTOR EXIT — 101 is unreachable, which removes both the
// loss checkpoints and the +$900 upside grid for D without touching A's, B's or C's exit.
export const VECTOR_EXIT_BY_SYSTEM = { C: C_VECTOR_EXIT, C_LEGACY: C_LEGACY_VECTOR_EXIT, D: 101 };

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
export const HALTED_SYSTEMS = ["B"];

const HALTED = new Set(HALTED_SYSTEMS.map((s) => String(s).trim().toUpperCase()));

export function isSystemHalted(system) {
  return HALTED.has(String(system ?? "").trim().toUpperCase());
}

// ---------------------------------------------------------------------------
// DART A (ANEW) TRADES DART C'S EXIT RULE SET — 2026-11-18, STEP 1 part 2.
//
// The owner directed that A's exits be IDENTICAL to C's. Every ANEW row below is
// ASSIGNED FROM C'S OWN LIVE ROW in this same file, at load time: not one exit
// value is typed here, so changing C changes A with it and the two accounts cannot
// drift. C's live row is C_LEGACY wherever a position resolves through ruleKeyFor()
// (the hard loss stop, the Protective Stop, the trail giveback, the session close
// and the Vector Exit), and C's plain row for the rules the engine reads by the
// account's own name (Profit Protection and the +$1,000 automatic arm).
//
// B, C and D are untouched: every row above keeps the value it had.
//   hard loss stop / safety net  SYSTEM_HARD_STOP          -$1,200 -> C's -$400
//   Profit Protection            SYSTEM_PARTIAL_PROFIT     +$1,850 -> C's +$850, 25%
//   automatic hard stop          AUTO_ARM_PL_BY_SYSTEM     +$2,000 -> C's +$1,000, $250
//   Protective Stop              PROTECTIVE_BY_SYSTEM      B's 55/65 -> C's 101/101 (off)
//   trailing stop                TRAIL_GIVEBACK_BY_SYSTEM  price trail -> C's $100 giveback
//   Vector Exit                  VECTOR_EXIT_BY_SYSTEM     65 -> C's 101 (off)
//   session close                SYSTEM_CLOSE_MINUTE       16:00 -> C's 15:00, close_1500
//   presses                      CLONE_PRESS1 / PRESS_PLAN - already identical to C's:
//                                +$200, then +$400, then +$1,100, $40,000 each
// ---------------------------------------------------------------------------
SYSTEM_HARD_STOP.ANEW = SYSTEM_HARD_STOP.C_LEGACY;
SYSTEM_PARTIAL_PROFIT.ANEW = SYSTEM_PARTIAL_PROFIT.C;
AUTO_ARM_PL_BY_SYSTEM.ANEW = AUTO_ARM_PL_BY_SYSTEM.C;
PROTECTIVE_BY_SYSTEM.ANEW = PROTECTIVE_BY_SYSTEM.C_LEGACY;
TRAIL_GIVEBACK_BY_SYSTEM.ANEW = TRAIL_GIVEBACK_BY_SYSTEM.C_LEGACY;
VECTOR_EXIT_BY_SYSTEM.ANEW = VECTOR_EXIT_BY_SYSTEM.C_LEGACY;
SYSTEM_CLOSE_MINUTE.ANEW = SYSTEM_CLOSE_MINUTE.C_LEGACY;
FULL_SESSION_CLOSE_DATES.ANEW = FULL_SESSION_CLOSE_DATES.C_LEGACY;
