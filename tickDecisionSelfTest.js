// tickDecisionSelfTest.js — pins the portable decision engine to the live rules.
//
//     node render-worker/tickDecisionSelfTest.js
//
// Every expected value below was derived by hand from the Base44 source
// (shared/cloneTick.ts and the modules it imports), not from running this engine —
// so a passing run proves the port agrees with the live rules rather than with
// itself. Exit code 0 = the engine may be used for shadow comparison. Exit code 1 =
// do NOT advance: the failing case names the rule that diverged.
//
// No network, no database, no clock, no trading record. Pure arithmetic.

import { decideTick } from "./tickDecisionCore.js";
import { press1Threshold, systemStop, protectivePolicy, partialProfitPolicy, autoArmPolicy, pressPlan, vectorExitThreshold, ruleKeyFor } from "./tickRules.js";
import { computeVector } from "./vectorCore.js";

const NOW = "2026-10-09T15:00:00.000Z";

const pos = (over) => ({
  id: "p1",
  status: "open",
  symbol: "TEST",
  side: "long",
  entry_time: "2026-10-09T13:30:00.000Z",
  entry_price: 100,
  shares: 200,
  tcb: 20000,
  peak_pl: 0,
  pressed_1r: false,
  pressed_2r: false,
  pressed_3r: false,
  protective_stop_active: false,
  price_trail_active: false,
  checked_loss_levels: [],
  profit_grid_active: false,
  commission_fees: 0,
  presses: [],
  ...(over || {}),
});

const tick = (system, position, price, extra) =>
  decideTick({ system, position, price, nowIso: NOW, ...(extra || {}) });

const cases = [];
function check(name, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  cases.push({ name, pass, actual, expected });
}

// --- RULE TABLE MIRROR ---------------------------------------------------------
check("Press 1 per system", [press1Threshold("ANEW"), press1Threshold("B"), press1Threshold("C"), press1Threshold("D")], [250, 250, 250, 250]);
check("hard stop per system: A -$200, B -$1,200, C -$1,200 (raised from -$100 at 1:44:55 PM ET 2026-11-13), D -$1,200", [systemStop("ANEW"), systemStop("B"), systemStop("C"), systemStop("D")], [-200, -1200, -1200, -1200]);
// C's cutover was CANCELLED, so EVERY C position — whatever its entry time, and a row
// with none — resolves to C_LEGACY at -$1,200, and the "C" alias carries the same number.
check("every C position resolves to C_LEGACY at -$1,200", [ruleKeyFor("C", { entry_time: "2026-11-13T14:00:00.000Z" }), ruleKeyFor("C", { entry_time: "2026-11-16T16:00:00.000Z" }), ruleKeyFor("C", {}), systemStop("C_LEGACY"), systemStop("C")], ["C_LEGACY", "C_LEGACY", "C_LEGACY", -1200, -1200]);
check("ruleKeyFor leaves every other account untouched", [ruleKeyFor("B", { entry_time: "2026-11-13T14:00:00.000Z" }), ruleKeyFor("ANEW", { entry_time: "2026-11-13T14:00:00.000Z" }), ruleKeyFor("D", {})], ["B", "ANEW", "D"]);
// Every live account carries its own row; the shared -$1,700 survives only as the
// fallback for a legacy record such as DART A's old "A" alias.
check("an unlisted legacy system falls back to the shared -$1,700", systemStop("A"), -1700);
check("protective policy: A and B arm at 55/65, C at its own 45/85 on both C rows, D at 55/65 with a $700 giveback", [protectivePolicy("ANEW").stockThreshold, protectivePolicy("B").marketThreshold, protectivePolicy("C").stockThreshold, protectivePolicy("C").marketThreshold, protectivePolicy("C").buffer, protectivePolicy("C_LEGACY").stockThreshold, protectivePolicy("C_LEGACY").marketThreshold, protectivePolicy("D").buffer], [55, 65, 45, 85, 350, 45, 85, 700]);
check("D runs B's 55/65 rule set and D's press is +$250", [protectivePolicy("D").stockThreshold, protectivePolicy("D").marketThreshold, press1Threshold("D"), pressPlan("D").single], [55, 65, 250, true]);
// A trades as ANEW in every table; "A" survives only as a legacy alias (protective
// policy keeps one so a historical record still resolves, the partial table does not).
check("Profit Protection: A(ANEW), B, C and D sell 25% at +$1,850; E and the 'A' alias have none", [partialProfitPolicy("ANEW"), partialProfitPolicy("B"), partialProfitPolicy("C"), partialProfitPolicy("D"), partialProfitPolicy("E"), partialProfitPolicy("A")], [{ threshold: 1850, fraction: 0.25 }, { threshold: 1850, fraction: 0.25 }, { threshold: 1850, fraction: 0.25 }, { threshold: 1850, fraction: 0.25 }, null, null]);

// Every loss level is pre-checked on the positions below, so no Vector checkpoint can
// act and the hard stop is the only rule that can speak on these prices.
const ALL_LOSS_LEVELS = Array.from({ length: 17 }, (_, i) => -100 * (i + 1));
const deep = () => pos({ checked_loss_levels: ALL_LOSS_LEVELS });

// --- 1. HARD STOP (B at its own -$1,200) --------------------------------------
// long 200 sh, basis $20,000 at $94.00 -> P&L exactly -$1,200. Fees: commission
// 0.70 + SEC 0.52 + TAF 0.03 + clearing 0.04 = 1.30, slippage 1.88 -> 3.18.
const t1 = tick("B", deep(), 94);
check("hard stop fires at -$1,200", [t1.action, t1.event, t1.exit_price, t1.gross_pl], ["exit", "realtime_stop_close", 94, -1200]);
check("hard stop costs", [t1.commission_fees, t1.net_pl], [3.18, -1203.18]);

// --- 1b. THE FOUR STOP LEVELS (C MOVED TO -$1,200 ON 2026-11-13) ---------------
// A -$200, B -$1,200, C -$1,200 (raised from -$100 at 1:44:55 PM ET on 2026-11-13,
// mid-session), D -$1,200. Every C position, whatever its entry time, is the LEGACY
// row. 200 shares on a $20,000 basis: $99.00 is exactly -$200, $94.00 exactly
// -$1,200 and $91.50 exactly -$1,700 (a level no live account runs any more);
// $99.50 is exactly -$100, which no live account runs any more either.
check("A closes at -$200", [tick("ANEW", deep(), 99).event, tick("ANEW", deep(), 99).gross_pl], ["realtime_stop_close", -200]);
check("A holds just above -$200", [tick("ANEW", deep(), 99.5).action], ["hold"]);
check("B closes at -$1,200", [tick("B", deep(), 94).event, tick("B", deep(), 94).gross_pl], ["realtime_stop_close", -1200]);
check("B holds just above -$1,200", [tick("B", deep(), 94.5).action], ["hold"]);
check("C closes at -$1,200", [tick("C", deep(), 94).event, tick("C", deep(), 94).gross_pl], ["realtime_stop_close", -1200]);
check("C holds just above -$1,200", [tick("C", deep(), 94.5).action], ["hold"]);
check("C no longer closes at -$100", [tick("C", deep(), 99.5).action, tick("C", deep(), 99.8).action], ["hold", "hold"]);
// A C position opened on ANY later date runs the same -$1,200 — there is no cutover.
const cNew = () => pos({ checked_loss_levels: ALL_LOSS_LEVELS, entry_time: "2026-11-16T16:00:00.000Z" });
check("a later C position closes at the same -$1,200", [tick("C", cNew(), 94).event, tick("C", cNew(), 94).gross_pl], ["realtime_stop_close", -1200]);
check("a later C position holds just above -$1,200 and closes at -$1,200", [tick("C", cNew(), 94.5).action, tick("C", cNew(), 94).action], ["hold", "exit"]);
check("D closes at -$1,200 and holds just above it", [tick("D", deep(), 94).event, tick("D", deep(), 94.5).action], ["realtime_stop_close", "hold"]);
check("no account borrows another's stop: D untouched at -$200, A untouched at -$100, B untouched at -$100", [tick("D", deep(), 99).action, tick("ANEW", deep(), 99.5).action, tick("B", deep(), 99).action], ["hold", "hold", "hold"]);

// --- 1b. HARD LOSS STOP ON A SECOND VALID PRINT (2026-11-13 10:58 ET) ----------
// The live engine passes hardStopConfirm, so one print through the level arms the stop and the
// next print through it closes the position. The exit itself is untouched: same reason, same
// price, same costs. A caller that passes nothing — the replay, the sweeps, every case above —
// keeps the single-print behaviour those comparisons were built on.
const arming = { pending: false };
const confirmed = { pending: true };

const armTick = tick("B", deep(), 94, { hardStopConfirm: arming });
check("the first print through the hard stop only ARMS it", [armTick.action, armTick.reason, armTick.event ?? null], ["pending_confirm", "hard_stop_awaiting_second_print", null]);
check("the arming print writes nothing to the trade", [armTick.exit_price ?? null, armTick.gross_pl ?? null, armTick.net_pl ?? null], [null, null, null]);

const fireTick = tick("B", deep(), 94, { hardStopConfirm: confirmed });
check("the second print through the level CLOSES it, at the same numbers", [fireTick.action, fireTick.event, fireTick.exit_price, fireTick.gross_pl, fireTick.net_pl], ["exit", "realtime_stop_close", 94, -1200, -1203.18]);
check("a confirming print deeper through the level closes it too", [tick("B", deep(), 93.5, { hardStopConfirm: confirmed }).action, tick("B", deep(), 93.5, { hardStopConfirm: confirmed }).gross_pl], ["exit", -1300]);
check("a price back above the level holds and writes no exit", [tick("B", deep(), 94.5, { hardStopConfirm: confirmed }).action, tick("B", deep(), 94.5, { hardStopConfirm: confirmed }).exit_price ?? null], ["hold", null]);
check("without confirmation one print still exits (replay and sweeps unchanged)", tick("B", deep(), 94).action, "exit");
check("the confirmation covers every account's own stop", [tick("ANEW", deep(), 99, { hardStopConfirm: arming }).action, tick("C", deep(), 94, { hardStopConfirm: arming }).action, tick("D", deep(), 94, { hardStopConfirm: arming }).action], ["pending_confirm", "pending_confirm", "pending_confirm"]);

// --- 2. PRESS 1 (B at +$250) --------------------------------------------------
const t2 = tick("B", pos(), 101.25);
check("press 1 at +$250", [t2.action, t2.event, t2.pl_raw], ["press", "press1", 250]);
check("press 1 sizing and cost", [t2.shares_added, t2.patch.tcb, t2.shares_after, t2.commission_fees], [395, 59993.75, 595, 5.46]);

// --- 3. DART D's ONE PRESS (at +$250, sized by its daily buying power) --------
// D is B's rule set plus ONE change: a single press at B's own Press 1 level, +$250,
// sized at the moment it fires from D's buying power for the day (2026-11-10, before
// the fresh test). 200 sh at 101.25 -> P&L $250, sized $10,100 at that price -> 99
// shares. Fees: commission 0.35 + clearing 0.02 + slippage 1.00.
const t3 = tick("D", pos(), 101.25, { halted: false, pressSizeUsd: 10100 });
check("D presses once at +$250", [t3.action, t3.event, t3.pl_raw, t3.press_size_usd, t3.press_level], ["press", "press1", 250, 10100, "1R"]);
check("D press arithmetic", [t3.shares_added, t3.shares_after, t3.patch.tcb, t3.commission_fees], [99, 299, 30023.75, 1.37]);
check("D's trail starts at its one press", [t3.patch.price_trail_active, t3.patch.price_trail_extreme, t3.patch.pressed_2r, t3.patch.pressed_3r], [true, 101.25, false, false]);
// No second rung exists: above +$700 and +$800 a pressed D still only holds.
const t3b = tick("D", pos({ pressed_1r: true, shares: 299, tcb: 30023.75, price_trail_active: true, price_trail_extreme: 101.25 }), 103, { halted: false, pressSizeUsd: 10100 });
check("D never presses twice", [t3b.action, t3b.event], ["hold", "hold"]);
// An unmeasured press is never guessed, and less than $20,000 free is a skip.
check("D without today's budget does not press", tick("D", pos(), 101.25, { halted: false }).action, "needs_budget");
check("D under the $20,000 floor skips", tick("D", pos(), 101.25, { halted: false, pressBudgetFree: 15000 }).reason, "press_budget_floor");

// --- 4. A (ANEW) CARRIES B'S 25% SALE AT +$1,850 ------------------------------
// A is B plus the 5-minute delay, so it carries B's Profit Protection too. 200 sh at
// $110 on a $100 basis is +$2,000, so the sale fires before the +$900 grid can.
const t4 = tick("ANEW", pos(), 110, { vectorScore: 30 });
check("A sells 25% at +$1,850", [t4.action, t4.event, t4.sold_shares, t4.remaining_shares, t4.gross_pl], ["partial", "partial_profit_exit", 50, 150, 500]);

// --- 5. UPSIDE VECTOR EXIT (ANEW, score 70 at activation) --------------------
// A (ANEW) carries no partial-profit rule, so the +$900 grid is what decides here.
const t5 = tick("ANEW", pos(), 105, { vectorScore: 70 });
check("upside Vector exit", [t5.action, t5.event, t5.vector_level], ["exit", "vector_profit_exit", 900]);

// --- 5b. B'S 25% SALE AT +$1,850 (added 2026-11-10, at the owner's direction) --
// The same position at +$2,000 sells a quarter of its 200 shares before anything
// else: 50 shares at $110 on a $100 cost basis, so $500 banked gross.
const t5b = tick("B", pos(), 110, { vectorScore: 70 });
check(
  "B sells 25% at +$1,850",
  [t5b.action, t5b.event, t5b.fraction, t5b.sold_shares, t5b.remaining_shares, t5b.gross_pl],
  ["partial", "partial_profit_exit", 0.25, 50, 150, 500]
);
check(
  "B's sale patches the position",
  [t5b.patch.shares, t5b.patch.partial_profit_taken, t5b.patch.partial_exits.length],
  [150, true, 1]
);
check("B holds below +$1,850", tick("B", pos(), 108, { vectorScore: 20 }).action === "partial", false);
check(
  "B sells only once",
  tick("B", pos({ partial_profit_taken: true, partial_exits: [{ gross_pl: 500 }] }), 110, { vectorScore: 70 }).action === "partial",
  false
);

// --- 6. DOWNSIDE VECTOR EXIT (score 80) --------------------------------------
// B's stop is -$1,200, so this price is -$300: crossed checkpoints without the stop.
const t6 = tick("B", pos(), 98.5, { vectorScore: 80 });
check("downside Vector exit", [t6.action, t6.event, t6.vector_level, t6.patch.checked_loss_levels], ["exit", "vector_exit", -100, [-100]]);

// --- 7. DOWNSIDE VECTOR HOLD (score 40) --------------------------------------
const t7 = tick("B", pos(), 98.5, { vectorScore: 40 });
check("downside hold records every level", [t7.action, t7.event, t7.patch.checked_loss_levels.length, t7.patch.checked_loss_levels[2]], ["hold", "vector_checkpoint_hold", 3, -300]);

// --- 8. PROTECTIVE GIVEBACK ---------------------------------------------------
// high-water $1,300, buffer $350 -> protected $950; P&L $940 breaches it.
const t8 = tick("B", pos({ protective_stop_active: true, protective_high_water_pl: 1300 }), 104.7);
check("protective giveback exits", [t8.action, t8.event, t8.gross_pl, t8.commission_fees, t8.net_pl], ["exit", "protective_stop", 940, 3.45, 936.55]);

// --- 9. PROTECTIVE HIGH-WATER RATCHET (no breach) -----------------------------
const t9 = tick("B", pos({ protective_stop_active: true, protective_high_water_pl: 1000 }), 106, { vectorScore: 20 });
check("high-water ratchets up", [t9.action, t9.prior_patches[0]], ["grid", { protective_high_water_pl: 1200 }]);

// --- 10. PRICE TRAIL (C ladder) ---------------------------------------------
// The tier is chosen from PEAK profit, not current P&L. Stored peak $3,000 with
// current P&L $2,000 -> the $2,500 tier (0.50%): extreme $120.00 protects $119.40,
// so a price of $110.00 breaches.
const t10 = tick("C", pos({ price_trail_active: true, price_trail_extreme: 120, peak_pl: 3000, pressed_1r: true, pressed_2r: true }), 110, { halted: false });
check("price trail exits on the peak's tier", [t10.action, t10.event, t10.stop_detail.trail_pct, t10.stop_detail.trail_protected], ["exit", "price_trail_stop", 0.005, 119.4]);
check("price trail costs", [t10.gross_pl, t10.commission_fees], [2000, 3.58]);

// Same stored peak, but a price that lifts current P&L above it: the peak becomes
// $3,880 and the tighter 0.35% tier applies (protected $119.58), never the looser one.
const t10b = tick("C", pos({ price_trail_active: true, price_trail_extreme: 120, peak_pl: 3000, pressed_1r: true, pressed_2r: true }), 119.4, { halted: false });
check("current P&L above the peak tightens the tier", [t10b.action, t10b.event, t10b.stop_detail.trail_pct, t10b.stop_detail.trail_protected], ["exit", "price_trail_stop", 0.0035, 119.58]);

// --- 11. PRESS 3 PRECEDENCE --------------------------------------------------
const t11 = tick("B", pos({ pressed_1r: true, pressed_2r: true, shares: 400, tcb: 40000 }), 102);
check("press 3 fires before any press 2 repeat", [t11.action, t11.event, t11.press_level, t11.shares_added, t11.shares_after, t11.commission_fees], ["press", "press3", "3R", 392, 792, 5.45]);

// --- 12. HALTED ACCOUNT: no writes, no decisions -----------------------------
// No DART is halted today — A, B, C and D all trade and E is gone from the engine —
// so the guard is driven with the caller's own halt flag, the switch the worker uses.
const t12 = decideTick({ system: "B", position: pos(), price: 91.5, nowIso: NOW, halted: true });
check("halted account decides nothing", [t12.action, t12.halted, t12.patch], ["halted", true, undefined]);
check("halted account would otherwise stop out at this price", tick("B", pos(), 91.5).action, "exit");

// --- 13. MISSING VECTOR IS AN EXPLICIT GAP, NEVER A GUESS --------------------
const t13 = tick("B", pos(), 98.5);
check("missing vector asks for it", [t13.action, t13.pending_step, t13.loss_levels.length], ["needs_vector", "downside_vector", 3]);

// --- 14. SHORT SIDE FEES (press is a SELL for a short) -----------------------
const t14 = tick("ANEW", pos({ side: "short" }), 98.75);
check("short press 1", [t14.action, t14.event, t14.pl_raw, t14.shares_added, t14.shares_after, t14.commission_fees], ["press", "press1", 250, 405, 605, 6.68]);

// --- 15. HOLD LEAVES THE POSITION UNTOUCHED EXCEPT THE MARKS ----------------
const t15 = tick("B", pos({ pressed_1r: true, pressed_2r: true, price_trail_active: true, price_trail_extreme: 101 }), 100.9);
check("hold writes display marks only", [t15.action, t15.event, Object.keys(t15.patch).sort()], ["hold", "hold", ["current_pl", "current_price", "peak_pl"]]);

// --- 16. THE SCORE IS COMPUTED FROM CANDLES WHEN NONE IS PASSED --------------
// A clean 0.20-a-bar drift against a long: the Vector must read this as reversal.
function driftAgainst(side, n = 20) {
  const out = [];
  let p = 100;
  const sign = side === "long" ? -1 : 1;
  for (let i = 0; i < n; i++) {
    const o = p;
    const c = o + sign * 0.2;
    out.push({ open: o, high: Math.max(o, c) + 0.02, low: Math.min(o, c) - 0.02, close: c, volume: 5000 });
    p = c;
  }
  return out;
}
const driftBars = driftAgainst("long");
// 200 sh at 100, price 99.40 -> P&L -$120, so the -$100 checkpoint is crossed and
// the score decides it. No vectorScore argument: the candles must supply it.
const t16 = decideTick({ system: "B", position: pos(), price: 99.4, nowIso: NOW, candles: driftBars });
check("candles supply the score the downside check needs", [t16.action, t16.event, t16.vector_source], ["exit", "vector_exit", "candles"]);
check("the engine's score is the Vector module's own", t16.vector_score, computeVector(driftBars, driftBars.length - 1, "long", 100).combined_reversal_score);

// The live engine's own fallback (0 when its candle fetch is empty) must be opt-in,
// and when opted in the decision must match Base44 rather than deferring.
const t17 = decideTick({ system: "B", position: pos(), price: 99.4, nowIso: NOW, liveZeroFallback: true });
check("live zero fallback decides instead of deferring", [t17.action, t17.event, t17.vector_source], ["hold", "vector_checkpoint_hold", "live_zero_fallback"]);

// --- 18. THE +$2,000 AUTO-ARM (B and A from 2026-11-09; D carries B's whole set) --
// decideTick never arms: engineShadow applies autoArmPolicy(system) to the verdict.
// These pin the table so the row cannot move back silently.
check("A, B, C and D all arm at +$2,000 (C and D's giveback is their own row: $350, $700 for D)", [autoArmPolicy("ANEW"), autoArmPolicy("B"), autoArmPolicy("C"), autoArmPolicy("D")], [2000, 2000, 2000, 2000]);
check("B sells 25% once at +$1,850", partialProfitPolicy("B"), { threshold: 1850, fraction: 0.25 });
check("A sells the same quarter (A is B plus the delay)", partialProfitPolicy("ANEW"), { threshold: 1850, fraction: 0.25 });
check("D sells the same quarter (D is B plus one press)", partialProfitPolicy("D"), { threshold: 1850, fraction: 0.25 });
check("C sells the same quarter from 2026-11-11 (C is B's rules exactly)", partialProfitPolicy("C"), { threshold: 1850, fraction: 0.25 });
check("E has no row in any rule table", [partialProfitPolicy("E"), autoArmPolicy("E"), pressPlan("E")], [null, null, null]);
check("D's single press is +$250, sized from buying power, trail at that press", [press1Threshold("D"), pressPlan("D").single, pressPlan("D").dynamicSize, pressPlan("D").trailAtFirstPress], [250, true, true, true]);
// C's cutover to A's rules was CANCELLED 2026-11-13, so C arms at its own 45/85 and
// exits at its own 45 on every C position, and B is never touched by it.
check(
  "C arms at its own 45/85 on both C rows, never touching B's 55/65",
  [protectivePolicy("C").stockThreshold, protectivePolicy("C").marketThreshold, protectivePolicy("C_LEGACY").stockThreshold, protectivePolicy("C_LEGACY").marketThreshold, protectivePolicy("B").stockThreshold, protectivePolicy("B").marketThreshold],
  [45, 85, 45, 85, 55, 65]
);
check("Vector Exit: C closes at 45 on both C rows, every other account 65", [vectorExitThreshold("C"), vectorExitThreshold("C_LEGACY"), vectorExitThreshold("B"), vectorExitThreshold("D"), vectorExitThreshold("ANEW")], [45, 45, 65, 65, 65]);

// --- REPORT ------------------------------------------------------------------
const passed = cases.filter((c) => c.pass).length;
const failed = cases.filter((c) => !c.pass);

console.log("TICK DECISION CORE — SELF TEST");
console.log(`cases: ${cases.length}   passed: ${passed}   failed: ${failed.length}`);
for (const c of cases) {
  console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name}`);
  if (!c.pass) console.log(`        expected ${JSON.stringify(c.expected)}\n        actual   ${JSON.stringify(c.actual)}`);
}
if (failed.length) {
  console.log("\nFAILED — the portable engine does not match the live rules. Do not run shadow comparison.");
  process.exit(1);
}
console.log("\nALL RULES MATCH BASE44. The portable engine is ready for shadow comparison.");