// protectiveTriggerSelfTest.js — pins the portable protective trigger to the live rule.
//
//     node render-worker/protectiveTriggerSelfTest.js
//
// Every expected number below is derived by hand from the rule in
// functions/manageProtectiveStops/entry.ts (the thresholds from protectiveStop.ts,
// the high-water from the bar's own extreme, the giveback from the tick engine), not
// from running this module — so a passing run proves the port agrees with the live
// rule rather than with itself. Exit 0 = ready for shadow comparison. Exit 1 = the
// failing case names the rule that diverged.
//
// No network, no database, no clock, no trading record. Pure arithmetic.

import { assessProtectiveTrigger, scoreLastBar } from "./protectiveTrigger.js";
import { decideTick } from "./tickDecisionCore.js";

const NOW = "2026-11-02T15:00:00.000Z";

const pos = (over) => ({
  id: "p1",
  status: "open",
  symbol: "TEST",
  exchange: "NASDAQ",
  side: "long",
  entry_price: 100,
  shares: 200,
  tcb: 20000,
  protective_stop_active: false,
  ...(over || {}),
});

// One bar whose favourable extreme is precisely known: high 104.70, low 95.30.
const bar = (close = 100) => ({ open: 100, high: 104.7, low: 95.3, close, volume: 5000 });

// A clean monotone move AGAINST a long: the computed stock score must be high.
function decliningSeries(n, side = "long", start = 100) {
  const out = [];
  let p = start;
  const sign = side === "long" ? -1 : 1;
  for (let i = 0; i < n; i++) {
    const o = p;
    const c = o + sign * (0.15 + (i % 3) * 0.01);
    out.push({ open: o, high: Math.max(o, c) + 0.02, low: Math.min(o, c) - 0.02, close: c, volume: 6000 });
    p = c;
  }
  return out;
}

const cases = [];
function check(name, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  cases.push({ name, pass, actual, expected });
}

const assess = (system, position, extra) => assessProtectiveTrigger({ system, position, nowIso: NOW, ...(extra || {}) });

// --- 1. THRESHOLDS ARE PER SYSTEM AND PER POSITION ---------------------------
// DART C became an exact copy of DART A at its 2026-11-13 10:45:00 AM ET cutover
// (15:45:00Z): from then it arms at A's 55/65. A C position OPENED BEFORE that
// instant keeps C's retired 45/85 until it closes, which is what the legacy fixture
// below pins (tickRules.ruleKeyFor / PROTECTIVE_BY_SYSTEM.C_LEGACY).
const LEGACY_C = { entry_time: "2026-11-13T14:00:00.000Z" }; // 9:00 AM ET, before the cutover
const NEW_C = { entry_time: "2026-11-13T16:00:00.000Z" }; // 11:00 AM ET, after it

const holdC = assess("C", pos(NEW_C), { stockScore: 54.99, marketScore: 64.99 });
check("a C position opened after the cutover holds just below 55/65", [holdC.action, holdC.event, holdC.rule_key], ["hold", "protective_not_armed", "C"]);

const bars = [bar(100)];
const armC = assess("C", pos(LEGACY_C), { stockScore: 45, marketScore: 10, candles: bars });
check("a C position opened before the cutover still arms at exactly stock 45", [armC.action, armC.triggered_by, armC.rule_key], ["activate", "stock", "C_LEGACY"]);

const sameForB = assess("B", pos(), { stockScore: 60, marketScore: 10, candles: bars });
const sameForC = assess("C", pos(NEW_C), { stockScore: 60, marketScore: 10, candles: bars });
check("stock 60 arms B and a post-cutover C alike", [sameForB.action, sameForC.action], ["activate", "activate"]);

// On A's row market 65 ALONE arms the new C; a legacy C position still needs 85.
const market65C = assess("C", pos(NEW_C), { stockScore: 10, marketScore: 65, candles: bars });
check("market 65 alone arms a post-cutover C (A's row)", [market65C.action, market65C.triggered_by], ["activate", "market"]);

const market65Legacy = assess("C", pos(LEGACY_C), { stockScore: 10, marketScore: 65, candles: bars });
check("market 65 alone does not arm a legacy C position", [market65Legacy.action, market65Legacy.event], ["hold", "protective_not_armed"]);

const marketOnly = assess("C", pos(NEW_C), { stockScore: 10, marketScore: 85, candles: bars });
check("market 85 arms C as well", [marketOnly.action, marketOnly.triggered_by], ["activate", "market"]);

// A score with no bar under it cannot become a high-water: refuse, never arm at zero.
const noBar = assess("C", pos(), { stockScore: 99, marketScore: 99 });
check("a score without a bar refuses to arm", [noBar.action, noBar.reason, noBar.patch], ["no_reference_price", "no_bar_extreme", undefined]);

// --- 2. HIGH-WATER COMES FROM THE BAR'S EXTREME, NOT THE PRICE --------------
// long 200 sh at 100 (basis $20,000), bar high 104.70 -> (104.70 - 100) * 200 = $940
check("long high-water uses the bar high", [armC.reference_price, armC.patch.protective_high_water_pl], [104.7, 940]);

// --- 3. SHORT SIDE USES THE BAR LOW -----------------------------------------
const shortArm = assess("C", pos({ side: "short" }), { stockScore: 90, candles: [bar(100)] });
check("short high-water uses the bar low", [shortArm.reference_price, shortArm.patch.protective_high_water_pl], [95.3, 940]);

// --- 4. THE PATCH IS EXACTLY THE FIELDS THE LIVE FUNCTION WRITES -------------
check("activation patch", armC.patch, {
  protective_stop_active: true,
  protective_high_water_pl: 940,
  protective_triggered_time: NOW,
  protective_triggered_stock_vec: 45, // the score armC armed on: C now arms at stock 45
  protective_triggered_market_vec: 10,
});

// --- 5. GUARDS: NEVER RE-ARM, NEVER ARM A CLOSED POSITION -------------------
const already = assess("C", pos({ protective_stop_active: true }), { stockScore: 99, marketScore: 99 });
check("already armed is skipped", [already.action, already.reason, already.patch], ["skipped", "already_active", undefined]);

const closed = assess("C", pos({ status: "closed" }), { stockScore: 99, marketScore: 99 });
check("closed position is skipped", [closed.action, closed.reason], ["skipped", "already_closed"]);

const zeroShares = assess("C", pos({ shares: 0 }), { stockScore: 99, marketScore: 99 });
check("zero shares is skipped", [zeroShares.action, zeroShares.reason], ["skipped", "no_shares"]);

// --- 6. A MISSING FEED IS NEVER CALM ----------------------------------------
const noFeed = assess("C", pos(), {});
check("no candles and no score refuses to arm", [noFeed.action, noFeed.reason, noFeed.stock_score, noFeed.market_score], ["no_candles", "no_score_available", null, null]);

// --- 7. THE COMPUTED PATH (candles in, no injected score) -------------------
const series = decliningSeries(20, "long", 100);
const computed = assess("C", pos({ entry_price: 100 }), { candles: series });
check("a declining long arms on computed candles", [computed.action, computed.triggered_by], ["activate", "stock"]);
check("computed score equals the Vector module's own", computed.stock_score, scoreLastBar(series, "long", 100));
check("computed score clears C's threshold", computed.stock_score >= 65, true);

// The market leg follows the same side as the stock trade: a falling SPY arms a SHORT.
const risingSpy = decliningSeries(20, "short", 500);
const shortMarket = assess("C", pos({ side: "short" }), { stockScore: 0, candles: bars, marketCandles: risingSpy });
check("a rising market arms a short via the market leg", [shortMarket.action, shortMarket.triggered_by], ["activate", "market"]);

// --- 8. END TO END WITH THE TICK ENGINE -------------------------------------
// Armed high-water $940, buffer $350 -> protected level $590. Long 200 sh at 100:
// a price of 102.95 gives P&L of exactly $590, which breaches (P&L <= protected).
const armedPos = pos({ protective_stop_active: true, protective_high_water_pl: 940 });
const breached = decideTick({ system: "C", position: armedPos, price: 102.95, nowIso: NOW, halted: false });
check("the engine exits on the armed high-water", [breached.action, breached.event, breached.gross_pl], ["exit", "protective_stop", 590]);

// One cent higher and the same position is held: the buffer is a buffer, not a hair.
const held = decideTick({ system: "C", position: armedPos, price: 102.96, nowIso: NOW, halted: false });
check("one cent above the protected level holds", held.action !== "exit", true);

// --- REPORT ------------------------------------------------------------------
const passed = cases.filter((c) => c.pass).length;
const failed = cases.filter((c) => !c.pass);

console.log("PROTECTIVE TRIGGER — SELF TEST");
console.log(`cases: ${cases.length}   passed: ${passed}   failed: ${failed.length}`);
for (const c of cases) {
  console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name}`);
  if (!c.pass) console.log(`        expected ${JSON.stringify(c.expected)}\n        actual   ${JSON.stringify(c.actual)}`);
}
if (failed.length) {
  console.log("\nFAILED — the portable trigger does not match the live rule. Do not run shadow comparison.");
  process.exit(1);
}
console.log("\nALL CASES MATCH THE LIVE RULE. The protective trigger is ready for shadow comparison.");