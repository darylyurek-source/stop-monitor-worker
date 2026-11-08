// migrationSelfTest.js — the checks that must pass before any account is switched.
//
// Covers the three rules added for the live cutover (protective arming, the 16:00 ET
// session close, and the arming write that a hold carries) plus the management rules
// they sit beside: the press ladder, both stops, the price trail, a Vector exit, a
// partial sale, and the closed-position guard that prevents a double exit.
//
// Deterministic: no clock, no network, no database. Run with:
//   node render-worker/migrationSelfTest.js
// It prints one line per case and exits non-zero when any case diverges.

import { decideTick, SESSION_CLOSE_MINUTE, etMinuteOfDay } from "./tickDecisionCore.js";
import { assessProtectiveTrigger } from "./protectiveTrigger.js";
import { r2, unrealized, press1Threshold, systemStop, protectivePolicy, partialProfitPolicy } from "./tickRules.js";

const results = [];
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, ok, actual, expected });
  return ok;
}

// A synthetic series: closes walk from `from` to `to` over `n` bars, each bar's
// high/low straddling its close by `wick`.
function series(from, to, n, wick = 0.05, startMs = Date.parse("2026-10-30T13:30:00Z")) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const close = from + ((to - from) * i) / (n - 1);
    out.push({
      t: startMs + i * 60000,
      open: i === 0 ? from : from + ((to - from) * (i - 1)) / (n - 1),
      high: close + wick,
      low: close - wick,
      close,
      volume: 1000,
    });
  }
  return out;
}

function pos(over) {
  return {
    symbol: "TEST", side: "long", status: "open",
    entry_price: 50, shares: 400, tcb: 20000,
    pressed_1r: false, pressed_2r: false, pressed_3r: false,
    presses: [], commission_fees: 0, peak_pl: 0, ...over,
  };
}

// --- 1. protective arming ----------------------------------------------------
// A long that has turned down hard must arm: the stock Vector scores the reversal.
{
  const bars = series(60, 52, 30);
  const p = pos({ entry_price: 60, shares: 500, tcb: 30000 });
  const a = assessProtectiveTrigger({
    system: "B", position: p, nowIso: "2026-10-30T15:00:00Z", candles: bars, price: 52,
  });
  check("arming: deteriorating long arms", a.action, "activate");
  check("arming: threshold used is B's 55", a.stock_threshold, 55);
  check("arming: high-water taken from the bar high, not the close",
    a.patch.protective_high_water_pl, r2((bars[bars.length - 1].high - 60) * 500));
  check("arming: patch carries the armed flag", a.patch.protective_stop_active, true);
}
// A calm long must not arm.
{
  const bars = series(50, 50.4, 30);
  const a = assessProtectiveTrigger({
    system: "B", position: pos({}), nowIso: "2026-10-30T15:00:00Z", candles: bars, price: 50.4,
  });
  check("arming: calm position does not arm", a.action, "hold");
}
// No candles and no score: never arm on an absent feed.
{
  const a = assessProtectiveTrigger({ system: "B", position: pos({}), nowIso: "2026-10-30T15:00:00Z", candles: null });
  check("arming: no feed never arms", a.action, "no_candles");
}
// An already-armed position is never re-armed.
{
  const a = assessProtectiveTrigger({
    system: "B", position: pos({ protective_stop_active: true, protective_high_water_pl: 400 }),
    nowIso: "2026-10-30T15:00:00Z", candles: series(60, 52, 30),
  });
  check("arming: already armed is skipped", a.action, "skipped");
}

// --- 2. the giveback the arming enables --------------------------------------
{
  // Armed at +$400 of high-water: the $350 buffer means it closes at +$50.
  const armed = pos({ protective_stop_active: true, protective_high_water_pl: 400 });
  const exit = decideTick({
    system: "B", position: armed, price: 50 + 50 / 400, nowIso: "2026-10-30T15:30:00Z", vectorScore: 10,
  });
  check("giveback: excused at the $350 buffer", exit.action, "exit");
  check("giveback: reason is protective_stop", exit.exit_reason, "protective_stop");

  // Ladder complete, so nothing but the giveback can act here.
  const armedFull = { ...armed, pressed_1r: true, pressed_2r: true, pressed_3r: true };
  const hold = decideTick({
    system: "B", position: armedFull, price: 50 + 349 / 400, nowIso: "2026-10-30T15:30:00Z", vectorScore: 10,
  });
  check("giveback: holds inside the buffer", hold.action, "hold");
}

// --- 3. the 16:00 ET session close -------------------------------------------
check("close: 16:00 EDT is the bell", etMinuteOfDay("2026-10-29T20:00:00Z") >= SESSION_CLOSE_MINUTE, true);
check("close: 16:00 EST is the bell", etMinuteOfDay("2026-11-02T21:00:00Z") >= SESSION_CLOSE_MINUTE, true);
check("close: 15:59 EDT is not", etMinuteOfDay("2026-10-29T19:59:00Z") >= SESSION_CLOSE_MINUTE, false);
{
  const atBell = decideTick({
    system: "B", position: pos({}), price: 51, nowIso: "2026-10-29T20:00:00Z", vectorScore: 5,
  });
  check("close: an open position closes at 16:00 ET", atBell.exit_reason, "close_1600");
  const before = decideTick({
    system: "B", position: pos({}), price: 51, nowIso: "2026-10-29T19:59:00Z", vectorScore: 5,
  });
  check("close: not before the bell", before.action !== "exit", true);
}

// --- 4. the press ladder ------------------------------------------------------
{
  const lvl = press1Threshold("B");
  check("press: B's Press 1 level", lvl, 250);
  const p1 = decideTick({ system: "B", position: pos({}), price: 50 + lvl / 400 + 0.01, nowIso: "2026-10-30T14:00:00Z", vectorScore: 5 });
  check("press: Press 1 fires at its level", p1.action, "press");
  check("press: Press 1 size is $40,000 of stock", p1.press_level, "1R");
  check("press: shares added", p1.shares_added, Math.floor(40000 / (50 + lvl / 400 + 0.01)));

  const p2 = decideTick({ system: "B", position: pos({ pressed_1r: true }), price: 50 + 700 / 400 + 0.01, nowIso: "2026-10-30T14:00:00Z", vectorScore: 5 });
  check("press: Press 2 at +$700", p2.press_level, "2R");
  check("press: Press 2 activates the price trail", p2.patch.price_trail_active, true);

  const p3 = decideTick({ system: "B", position: pos({ pressed_1r: true, pressed_2r: true }), price: 50 + 800 / 400 + 0.01, nowIso: "2026-10-30T14:00:00Z", vectorScore: 5 });
  check("press: Press 3 at +$800", p3.press_level, "3R");
  const noRepress = decideTick({ system: "B", position: pos({ pressed_1r: true, pressed_2r: true, pressed_3r: true }), price: 50 + 900 / 400, nowIso: "2026-10-30T14:00:00Z", vectorScore: 5 });
  check("press: a completed ladder never presses again", noRepress.action !== "press", true);
}

// --- 5. stops, trail, vector, partial ----------------------------------------
{
  check("stop: B's hard stop", systemStop("B"), -1700);
  const hard = decideTick({ system: "B", position: pos({}), price: 50 - 1701 / 400, nowIso: "2026-10-30T14:00:00Z", vectorScore: 5 });
  check("stop: hard stop closes", hard.exit_reason, "realtime_stop_close");

  // Trail: active, extreme 60 on a long at 1.75% once peak is below +$900.
  const trail = decideTick({
    system: "B", position: pos({ price_trail_active: true, price_trail_extreme: 60, peak_pl: 500 }),
    price: 60 * (1 - 0.0175), nowIso: "2026-10-30T15:00:00Z", vectorScore: 5,
  });
  check("trail: breach closes", trail.exit_reason, "price_trail_stop");

  // Vector exit at a crossed loss checkpoint.
  const vec = decideTick({ system: "B", position: pos({}), price: 50 - 150 / 400, nowIso: "2026-10-30T14:00:00Z", vectorScore: 70 });
  check("vector: a crossed -$100 checkpoint with score 70 exits", vec.exit_reason, "vector_exit");
  const held = decideTick({ system: "B", position: pos({}), price: 50 - 150 / 400, nowIso: "2026-10-30T14:00:00Z", vectorScore: 64 });
  check("vector: score 64 holds the checkpoint", held.action, "hold");
  const gap = decideTick({ system: "B", position: pos({}), price: 50 - 150 / 400, nowIso: "2026-10-30T14:00:00Z" });
  check("vector: no score is a data gap, never a guess", gap.action, "needs_vector");

  // Partial sale: only D and E carry the rule now (both $1,500, half). DART C lost its
  // +$2,000 row on 2026-11-06 and B never had one (live: cloneSystems.ts
  // SYSTEM_PARTIAL_PROFIT). D is halted, so the shared arithmetic is exercised with the
  // halt guard lifted — the rule block is what is under test here.
  check("partial: C has none", partialProfitPolicy("C"), null);
  check("partial: B has none", partialProfitPolicy("B"), null);
  check("partial: D takes half at +$1,500", partialProfitPolicy("D"), { threshold: 1500, fraction: 0.5 });
  const part = decideTick({ system: "D", halted: false, position: pos({}), price: 50 + 1600 / 400, nowIso: "2026-10-30T14:00:00Z", vectorScore: 5 });
  check("partial: half the shares are sold", part.action, "partial");
  check("partial: 400 → 200", part.remaining_shares, 200);
  const twice = decideTick({ system: "D", halted: false, position: pos({ partial_profit_taken: true, shares: 200, tcb: 10000 }), price: 50 + 1600 / 200, nowIso: "2026-10-30T14:00:00Z", vectorScore: 5 });
  check("partial: never fires twice", twice.action !== "partial", true);
}

// --- 6. the closed-position guard (duplicate prevention at the rule level) ----
{
  const closed = decideTick({ system: "B", position: pos({ status: "closed" }), price: 51, nowIso: "2026-10-30T14:00:00Z", vectorScore: 5 });
  check("guard: a closed position decides nothing", closed.action, "skipped");
  check("guard: reason is already_closed", closed.reason, "already_closed");
  const halted = decideTick({ system: "D", position: pos({}), price: 51, nowIso: "2026-10-30T14:00:00Z", vectorScore: 5 });
  check("guard: a halted account trades nothing", halted.action, "halted");
}

// --- report ------------------------------------------------------------------
export function run() {
  const failed = results.filter((r) => !r.ok);
  return { total: results.length, passed: results.length - failed.length, failed, results };
}

const isMain = process.argv[1] && process.argv[1].endsWith("migrationSelfTest.js");
if (isMain) {
  const r = run();
  for (const c of r.results) console.log(`${c.ok ? "pass" : "FAIL"}  ${c.name}${c.ok ? "" : ` — got ${JSON.stringify(c.actual)}, expected ${JSON.stringify(c.expected)}`}`);
  console.log(`\n${r.passed}/${r.total} passed`);
  if (r.failed.length) {
    console.log("FAILED — do not activate Render.");
    process.exit(1);
  }
  console.log("All migration checks pass.");
}