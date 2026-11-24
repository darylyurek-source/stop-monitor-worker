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
import { press1Threshold, systemStop, protectivePolicy, partialProfitPolicy, autoArmPolicy, pressPlan, vectorExitThreshold, ruleKeyFor, systemCloseMinute, closeReasonFor, C_TRAIL_ARM_PL, C_TRAIL_GIVEBACK_USD, trailGivebackFor } from "./tickRules.js";
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
check("Press 1 per system: A, B, C and D all press at +$200 from 2026-11-18", [press1Threshold("ANEW"), press1Threshold("B"), press1Threshold("C"), press1Threshold("D")], [200, 200, 200, 200]);
check("hard stop per system: A, B and D -$400, C -$1,150 (C's own move 2026-11-24; A kept -$400)", [systemStop("ANEW"), systemStop("B"), systemStop("C"), systemStop("D")], [-400, -400, -1150, -400]);
// C's cutover was CANCELLED, so EVERY C position — whatever its entry time, and a row
// with none — resolves to C_LEGACY, whose hard stop is -$1,150 from 2026-11-24 (the owner's
// rule); the "C" alias carries the same number.
check("every C position resolves to C_LEGACY at -$1,150", [ruleKeyFor("C", { entry_time: "2026-11-13T14:00:00.000Z" }), ruleKeyFor("C", { entry_time: "2026-11-16T16:00:00.000Z" }), ruleKeyFor("C", {}), systemStop("C_LEGACY"), systemStop("C")], ["C_LEGACY", "C_LEGACY", "C_LEGACY", -1150, -1150]);
check("ruleKeyFor leaves every other account untouched", [ruleKeyFor("B", { entry_time: "2026-11-13T14:00:00.000Z" }), ruleKeyFor("ANEW", { entry_time: "2026-11-13T14:00:00.000Z" }), ruleKeyFor("D", {})], ["B", "ANEW", "D"]);
// Every live account carries its own row; the shared -$1,700 survives only as the
// fallback for a legacy record such as DART A's old "A" alias.
check("an unlisted legacy system falls back to the shared -$1,700", systemStop("A"), -1700);
check("protective policy: A, B, C and D all carry 101/101, so no Vector can arm any of them; A and B keep $250, C and C_LEGACY carry C's own $350 (2026-11-25)", [protectivePolicy("ANEW").stockThreshold, protectivePolicy("ANEW").marketThreshold, protectivePolicy("ANEW").buffer, protectivePolicy("B").stockThreshold, protectivePolicy("B").marketThreshold, protectivePolicy("B").buffer, protectivePolicy("C").stockThreshold, protectivePolicy("C").marketThreshold, protectivePolicy("C").buffer, protectivePolicy("C_LEGACY").stockThreshold, protectivePolicy("C_LEGACY").marketThreshold, protectivePolicy("D").buffer], [101, 101, 250, 101, 101, 250, 101, 101, 350, 101, 101, 250]);
check("D runs A's rule set (no Protective Stop) and D's own press is +$200", [protectivePolicy("D").stockThreshold, protectivePolicy("D").marketThreshold, press1Threshold("D"), pressPlan("D").single], [101, 101, 200, true]);
// A trades as ANEW in every table; "A" survives only as a legacy alias (protective
// policy keeps one so a historical record still resolves, the partial table does not).
check("Profit Protection: A, B and D sell 25% at +$850, C at +$1,400 (2026-11-25); E and the 'A' alias have none", [partialProfitPolicy("ANEW"), partialProfitPolicy("B"), partialProfitPolicy("C"), partialProfitPolicy("D"), partialProfitPolicy("E"), partialProfitPolicy("A")], [{ threshold: 850, fraction: 0.25 }, { threshold: 850, fraction: 0.25 }, { threshold: 1400, fraction: 0.25 }, { threshold: 850, fraction: 0.25 }, null, null]);

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

// --- 1b. THE FOUR STOP LEVELS --------------------------------------------------
// DART A trades C's exit rule set from 2026-11-18 (STEP 1 part 2), so its hard loss stop
// AND its safety-net level are C's -$400. B -$1,200 and D -$400 are unchanged. Every C
// position, whatever its entry time, is the LEGACY row. 200 shares on a $20,000 basis:
// $98.00 is exactly -$400, $94.00 exactly -$1,200, $99.00 exactly -$200 and $99.50 -$100.
check("A closes at -$400 (C's stop, from 2026-11-18)", [tick("ANEW", deep(), 98).event, tick("ANEW", deep(), 98).gross_pl], ["realtime_stop_close", -400]);
check("A holds just above -$400", [tick("ANEW", deep(), 98.05).action], ["hold"]);
check("A and C no longer share a stop: A closes at $98.00, C holds", [tick("ANEW", deep(), 98).action, tick("C", deep(), 98).action], ["exit", "hold"]);
check("A no longer closes at -$1,200 or -$200", [tick("ANEW", deep(), 94).action, tick("ANEW", deep(), 99).action, tick("ANEW", deep(), 99.5).action], ["exit", "hold", "hold"]);
check("B keeps its own -$400 row (at $94.00 it is simply deep through it)", [tick("B", deep(), 94).event, tick("B", deep(), 94).gross_pl], ["realtime_stop_close", -1200]);
check("B holds just above -$400", [tick("B", deep(), 98.05).action], ["hold"]);
check("C closes at -$1,150 (owner's rule, 2026-11-24)", [tick("C", deep(), 94.25).event, tick("C", deep(), 94.25).gross_pl], ["realtime_stop_close", -1150]);
check("C holds just above -$1,150 ($94.26 is -$1,148)", [tick("C", deep(), 94.26).action], ["hold"]);
check("C holds at the old -$400 that used to close it", [tick("C", deep(), 98).action, tick("C", deep(), 98.05).action], ["hold", "hold"]);
check("C is deep through -$1,150 at -$1,200, so that price still closes it", [tick("C", deep(), 94).action, tick("C", deep(), 94).event], ["exit", "realtime_stop_close"]);
// A C position opened on ANY later date runs the same -$1,150 — there is no cutover.
const cNew = () => pos({ checked_loss_levels: ALL_LOSS_LEVELS, entry_time: "2026-11-16T16:00:00.000Z" });
check("a later C position closes at the same -$1,150", [tick("C", cNew(), 94.25).event, tick("C", cNew(), 94.25).gross_pl], ["realtime_stop_close", -1150]);
check("a later C position holds just above -$1,150 and closes at -$1,150", [tick("C", cNew(), 94.26).action, tick("C", cNew(), 94.25).action], ["hold", "exit"]);
check("D closes at -$400 and holds just above it", [tick("D", deep(), 98).event, tick("D", deep(), 98.05).action], ["realtime_stop_close", "hold"]);
check("no account borrows another's stop: each holds above its own level", [tick("D", deep(), 99).action, tick("ANEW", deep(), 99.5).action, tick("B", deep(), 99).action], ["hold", "hold", "hold"]);

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
check("a price back above the level holds and writes no exit", [tick("B", deep(), 98.05, { hardStopConfirm: confirmed }).action, tick("B", deep(), 98.05, { hardStopConfirm: confirmed }).exit_price ?? null], ["hold", null]);
check("without confirmation one print still exits (replay and sweeps unchanged)", tick("B", deep(), 94).action, "exit");
check("the confirmation covers every account's own stop", [tick("ANEW", deep(), 94, { hardStopConfirm: arming }).action, tick("C", deep(), 94, { hardStopConfirm: arming }).action, tick("D", deep(), 94, { hardStopConfirm: arming }).action], ["pending_confirm", "pending_confirm", "pending_confirm"]);

// DART C alone, at its own -$1,150 (owner's cases, 2026-11-24): 200 sh at $100, $20,000 basis.
// $94.26 is -$1,148 and holds; $94.25 is exactly -$1,150 — the first print arms it, the next
// print at or through the level closes it. $98.00, the old -$400, no longer closes C.
check("C holds at $94.26 (-$1,148)", tick("C", deep(), 94.26, { hardStopConfirm: arming }).action, "hold");
check("C's first print at $94.25 only arms it", [tick("C", deep(), 94.25, { hardStopConfirm: arming }).action, tick("C", deep(), 94.25, { hardStopConfirm: arming }).reason], ["pending_confirm", "hard_stop_awaiting_second_print"]);
const cFire = tick("C", deep(), 94.25, { hardStopConfirm: confirmed });
check("C's next print at $94.25 closes it", [cFire.action, cFire.event, cFire.exit_price, cFire.gross_pl], ["exit", "realtime_stop_close", 94.25, -1150]);
check("C's next print lower closes it too", [tick("C", deep(), 94, { hardStopConfirm: confirmed }).action, tick("C", deep(), 94, { hardStopConfirm: confirmed }).gross_pl], ["exit", -1200]);
check("C at -$400 (the old level) holds, armed or not", [tick("C", deep(), 98).action, tick("C", deep(), 98, { hardStopConfirm: confirmed }).action], ["hold", "hold"]);

// --- 2. PRESS 1 (B at +$200) --------------------------------------------------
// 200 sh at $101.00 -> P&L $200, sized $40,000 at that price -> 396 shares.
// Fees: commission 1.39 + clearing 0.08 + slippage 4.00.
const t2 = tick("B", pos(), 101.0);
check("press 1 at +$200", [t2.action, t2.event, t2.pl_raw], ["press", "press1", 200]);
check("press 1 sizing and cost", [t2.shares_added, t2.patch.tcb, t2.shares_after, t2.commission_fees], [396, 59996, 596, 5.47]);

// --- 3. DART D's ONE PRESS (at +$200, sized by its daily buying power) --------
// D is A's rule set with ONE difference: a single press at D's own level, +$200 from
// 2026-11-18 (STEP 6), sized at the moment it fires from D's buying power for the day
// ($120,000 cap, skipped under $20,000 free). 200 sh at 101.00 -> P&L $200, sized
// $10,100 at that price -> 100 shares. Fees: commission 0.35 + clearing 0.02 + slippage 1.01.
const t3 = tick("D", pos(), 101.0, { halted: false, pressSizeUsd: 10100 });
check("D presses once at +$200", [t3.action, t3.event, t3.pl_raw, t3.press_size_usd, t3.press_level], ["press", "press1", 200, 10100, "1R"]);
check("D press arithmetic", [t3.shares_added, t3.shares_after, t3.patch.tcb, t3.commission_fees], [100, 300, 30100, 1.38]);
check("D's press does not start the trail (rule 8 arms it at +$500)", [t3.patch.price_trail_active ?? null, t3.patch.price_trail_extreme ?? null, t3.patch.pressed_2r, t3.patch.pressed_3r], [null, null, false, false]);
// D holds just under its own level, where B would still not have pressed either.
check("D does not press at +$199.99", tick("D", pos(), 100.99995, { halted: false, pressSizeUsd: 10100 }).action, "hold");
// No second rung exists: above +$400 and +$1,100 a pressed D still only holds.
const t3b = tick("D", pos({ pressed_1r: true, shares: 300, tcb: 30100, price_trail_active: true, price_trail_extreme: 101.0 }), 103, { halted: false, pressSizeUsd: 10100 });
check("D never presses twice", [t3b.action, t3b.event], ["hold", "hold"]);
// An unmeasured press is never guessed, and less than $20,000 free is a skip.
check("D without today's budget does not press", tick("D", pos(), 101.0, { halted: false }).action, "needs_budget");
check("D under the $20,000 floor skips", tick("D", pos(), 101.0, { halted: false, pressBudgetFree: 15000 }).reason, "press_budget_floor");

// --- 4. A (ANEW) CARRIES C'S 25% SALE AT +$850 -------------------------------
// A trades C's exit set from 2026-11-18, so its Profit Protection is C's: a quarter,
// once, at +$850. 200 sh at $110 on a $100 basis is +$2,000.
const t4 = tick("ANEW", pos(), 110, { vectorScore: 30 });
check("A sells 25% at +$850 (its own row from 2026-11-25)", [t4.action, t4.event, t4.sold_shares, t4.remaining_shares, t4.gross_pl], ["partial", "partial_profit_exit", 50, 150, 500]);

// --- 5. A (ANEW) HAS NO VECTOR EXIT — EXACTLY LIKE C -------------------------
// C's Vector Exit was removed on 2026-11-15 (101 is unreachable) and A carries C's row
// from 2026-11-18, so the same position at the same price must produce the SAME verdict
// on both accounts: no vector_profit_exit, C's quarter sold, C's automatic arm behind it.
const t5 = tick("ANEW", pos(), 105, { vectorScore: 70 });
const t5C = tick("C", pos(), 105, { vectorScore: 70 });
check("A has no Vector Exit (101, as C's)", [vectorExitThreshold("ANEW"), vectorExitThreshold("C_LEGACY")], [101, 101]);
check("at +$1,000 A sells its quarter while C waits for +$1,400 (their rows parted on 2026-11-25)", [t5.action, t5.event, t5.sold_shares, t5C.sold_shares ?? null, t5C.event === "partial_profit_exit"], ["partial", "partial_profit_exit", 50, null, false]);
check("neither account exits on the Vector any more", [t5.event, t5C.event, t5.vector_level ?? null, t5C.vector_level ?? null], ["partial_profit_exit", "vector_profit_activate", null, null]);

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
check("B holds below +$850", tick("B", pos(), 104, { vectorScore: 20 }).action === "partial", false);
check(
  "B sells only once",
  tick("B", pos({ partial_profit_taken: true, partial_exits: [{ gross_pl: 500 }] }), 110, { vectorScore: 70 }).action === "partial",
  false
);

// --- 6. DOWNSIDE VECTOR EXIT (score 80) --------------------------------------
// B's stop is -$1,200, so this price is -$300: crossed checkpoints without the stop.
const t6 = tick("B", pos(), 98.5, { vectorScore: 80 });
const t6C = tick("C", pos(), 98.5, { vectorScore: 80 });
check("no Vector score can close B — it answers exactly as C does", [t6.action, t6.action === t6C.action, t6.event === "vector_exit", t6.vector_level ?? null], ["hold", true, false, null]);

// --- 7. DOWNSIDE VECTOR HOLD (score 40) --------------------------------------
const t7 = tick("B", pos(), 98.5, { vectorScore: 40 });
check("downside hold records every level", [t7.action, t7.event, t7.patch.checked_loss_levels.length, t7.patch.checked_loss_levels[2]], ["hold", "vector_checkpoint_hold", 3, -300]);

// --- 8. PROTECTIVE GIVEBACK ---------------------------------------------------
// high-water $1,300, buffer $250 (B's own row from 2026-11-24) -> protected $1,050; P&L $940 breaches it.
const t8 = tick("B", pos({ protective_stop_active: true, protective_high_water_pl: 1300 }), 104.7);
check("protective giveback exits", [t8.action, t8.event, t8.gross_pl, t8.commission_fees, t8.net_pl], ["exit", "protective_stop", 940, 3.45, 936.55]);

// --- 9. PROTECTIVE HIGH-WATER RATCHET (no breach) -----------------------------
const t9 = tick("B", pos({ protective_stop_active: true, protective_high_water_pl: 1000 }), 106, { vectorScore: 20 });
const t9C = tick("C", pos({ protective_stop_active: true, protective_high_water_pl: 1000 }), 106, { vectorScore: 20 });
check("from 2026-11-25 B sells its quarter at +$850 where C waits for +$1,400 and re-bases its grid", [t9.action, t9.event, t9C.action, t9C.event], ["partial", "partial_profit_exit", "grid", "vector_profit_activate"]);

// --- 10. PRICE TRAIL (C HAS NONE FROM 2026-11-24; A AND D KEEP THE $100) -------
// DART C's $100 giveback trail was REMOVED (owner, in force from the 2026-11-24 session): C
// resolves to C_LEGACY, both keys are gone from TRAIL_GIVEBACK_BY_SYSTEM and both are in
// NO_PRICE_TRAIL_SYSTEMS, so a C position has no trail at all — it neither arms nor breaches,
// and it never falls back to the share-price percentage trail.
// Kept as the fixture the A case below uses.
const cTrail = (over) => pos({ price_trail_active: true, peak_pl: 3000, pressed_1r: true, pressed_2r: true, pressed_3r: true, partial_profit_taken: true, ...(over || {}) });
// The owner's case: +$600, then +$490. No trail exists, so both are a hold and nothing arms.
const cNoTrail = (over) => pos({ pressed_1r: true, pressed_2r: true, pressed_3r: true, partial_profit_taken: true, ...(over || {}) });
const t10 = tick("C", cNoTrail(), 103, { halted: false });
const t10b = tick("C", cNoTrail({ peak_pl: 600 }), 102.45, { halted: false });
check("C has no trail: +$600 then +$490 holds, and no trail is ever armed", [t10.action, (t10.prior_patches || []).some((p) => p && p.price_trail_active === true), t10b.action, t10b.event ?? null], ["hold", false, "hold", "hold"]);
check("C and C_LEGACY have no giveback row; A still has $100", [trailGivebackFor("C"), trailGivebackFor("C_LEGACY"), trailGivebackFor("ANEW")], [null, null, 100]);
// Arming: +$500 of peak P&L starts nothing on C.
const t10d = tick("C", cNoTrail({ peak_pl: 499 }), 102.49, { halted: false });
const t10e = tick("C", cNoTrail({ peak_pl: 500 }), 102.5, { halted: false });
check("C's trail no longer arms at +$500", [(t10d.prior_patches || []).some((p) => p && p.price_trail_active === true), (t10e.prior_patches || []).some((p) => p && p.price_trail_active === true)], [false, false]);

// DART D (2026-11-16, the owner's rule 8): the identical $100 giveback trail, resolved
// from D's own row. A and B have no row and keep the share-price percentage trail.
const dTrail = (over) => pos({ price_trail_active: true, peak_pl: 3000, pressed_1r: true, partial_profit_taken: true, ...(over || {}) });
const t10f = tick("D", dTrail(), 114, { halted: false });
check("D's trail exits on the same $100 giveback from its peak", [t10f.action, t10f.event, t10f.stop_detail.trail_protected], ["exit", "price_trail_stop", 2900]);
const t10g = tick("D", pos({ peak_pl: 499 }), 102.49, { halted: false });
const t10h = tick("D", pos({ peak_pl: 500 }), 102.5, { halted: false });
check("D's trail arms exactly at +$500", [trailGivebackFor("D"), t10g.prior_patches || [], (t10h.prior_patches || [])[0]], [100, [], { price_trail_active: true, price_trail_activated_time: NOW }]);
// DART A (2026-11-18): the identical $100 giveback trail, and no price trail at all.
const aTrail = tick("ANEW", cTrail(), 114, { halted: false });
check("A's trail exits on C's $100 giveback from its peak", [aTrail.action, aTrail.event, aTrail.stop_detail.trail_pct, aTrail.stop_detail.trail_protected], ["exit", "price_trail_stop", null, 2900]);
const aArmLow = tick("ANEW", pos({ peak_pl: 499 }), 102.49, { halted: false });
const aArmAt = tick("ANEW", pos({ peak_pl: 500 }), 102.5, { halted: false });
check("A's trail arms exactly at +$500 and writes no price extreme", [(aArmLow.prior_patches || []).length, (aArmAt.prior_patches || []).filter((p) => p && p.price_trail_active === true), (aArmAt.prior_patches || []).some((p) => p && p.price_trail_extreme != null)], [0, [{ price_trail_active: true, price_trail_activated_time: NOW }], false]);
check("the giveback rows from 2026-11-24: A, B and D have $100; C and C_LEGACY have none", [trailGivebackFor("ANEW"), trailGivebackFor("B"), trailGivebackFor("C"), trailGivebackFor("C_LEGACY"), trailGivebackFor("D")], [100, 100, null, null, 100]);

// --- 11. PRESS 3 PRECEDENCE --------------------------------------------------
// 400 sh at $102.75 -> P&L $1,100, sized $40,000 at that price -> 389 shares.
// Fees: commission 1.36 + clearing 0.08 + slippage 4.00.
// Press 3 moved to +$1,100 on 2026-11-18, so it now sits ABOVE the +$900 upside grid:
// the grid's checkpoint is resolved first, which is why the position is handed in with
// the grid already standing at +$1,100. The press rule itself is untouched.
const gridAt1100 = { profit_grid_active: true, last_profit_level: 1100, next_up_profit_level: 1200, next_down_profit_level: 1000 };
const t11 = tick("B", pos({ pressed_1r: true, pressed_2r: true, shares: 400, tcb: 40000, ...gridAt1100 }), 102.75, { vectorScore: 5 });
const t11C = tick("C", pos({ pressed_1r: true, pressed_2r: true, shares: 400, tcb: 40000, ...gridAt1100 }), 102.75, { vectorScore: 5 });
check("on a press-3 tick B sells its quarter at +$850 while C presses (its sale waits for +$1,400)", [t11.action, t11.event, t11.sold_shares ?? null, t11C.action, t11C.event, t11C.shares_added ?? null], ["partial", "partial_profit_exit", 100, "press", "press3", 389]);

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
check("candles supply the score the downside check needs (and cannot close B)", [t16.action, t16.event, t16.vector_source], ["hold", "vector_checkpoint_hold", "candles"]);
check("the engine's score is the Vector module's own", t16.vector_score, computeVector(driftBars, driftBars.length - 1, "long", 100).combined_reversal_score);

// The live engine's own fallback (0 when its candle fetch is empty) must be opt-in,
// and when opted in the decision must match Base44 rather than deferring.
const t17 = decideTick({ system: "B", position: pos(), price: 99.4, nowIso: NOW, liveZeroFallback: true });
check("live zero fallback decides instead of deferring", [t17.action, t17.event, t17.vector_source], ["hold", "vector_checkpoint_hold", "live_zero_fallback"]);

// --- 18. THE +$2,000 AUTO-ARM (B and A from 2026-11-09; D carries B's whole set) --
// decideTick never arms: engineShadow applies autoArmPolicy(system) to the verdict.
// These pin the table so the row cannot move back silently.
check("A and D arm at +$1,000, C arms at +$1,400 (the print its 25% sale fires on); B has NO automatic arm from 2026-11-25", [autoArmPolicy("ANEW"), autoArmPolicy("B"), autoArmPolicy("C"), autoArmPolicy("D")], [1000, null, 1400, 1000]);
check("B sells 25% once at +$850", partialProfitPolicy("B"), { threshold: 850, fraction: 0.25 });
check("A sells C's quarter at +$850 (A carries C's exit set from 2026-11-18)", partialProfitPolicy("ANEW"), { threshold: 850, fraction: 0.25 });
check("D sells a quarter at +$850 (C's rule 7, adopted 2026-11-16)", partialProfitPolicy("D"), { threshold: 850, fraction: 0.25 });
check("C sells a quarter at +$1,400 from 2026-11-25 (the owner's rule)", partialProfitPolicy("C"), { threshold: 1400, fraction: 0.25 });
check("E has no row in any rule table", [partialProfitPolicy("E"), autoArmPolicy("E"), pressPlan("E")], [null, null, null]);
check("D's single press is +$200, sized from buying power, and does NOT start the trail (rule 8 arms it at +$500)", [press1Threshold("D"), pressPlan("D").single, pressPlan("D").dynamicSize, pressPlan("D").trailAtFirstPress], [200, true, true, false]);
// The Protective Stop and the Vector Exit were REMOVED from C on 2026-11-15 and from D on
// 2026-11-16 (the owner's rule sets): both thresholds are unreachable on every C and D row,
// so neither rule can act on a C or a D position. A carries C's rows from 2026-11-18;
// B carries C's rows from 2026-11-24, so all four accounts read the same numbers.
check(
  "A, B, C and D can never arm (101/101)",
  [protectivePolicy("C").stockThreshold, protectivePolicy("C").marketThreshold, protectivePolicy("C_LEGACY").stockThreshold, protectivePolicy("C_LEGACY").marketThreshold, protectivePolicy("D").stockThreshold, protectivePolicy("D").marketThreshold, protectivePolicy("B").stockThreshold, protectivePolicy("B").marketThreshold],
  [101, 101, 101, 101, 101, 101, 101, 101]
);
check("giveback after the automatic arm: A, B and D $250, C and C_LEGACY $350", [protectivePolicy("ANEW").buffer, protectivePolicy("C").buffer, protectivePolicy("C_LEGACY").buffer, protectivePolicy("D").buffer, protectivePolicy("B").buffer], [250, 350, 350, 250, 250]);

// --- 18b. D IS A'S RULE SET, PRESS ASIDE (2026-11-18, the owner's STEP 6) ------
// Every exit row D resolves must equal A's, row for row: the hard stop, the Protective
// Stop, Profit Protection, the automatic arm and its giveback, the trail giveback, the
// Vector Exit and the session close. The press is the one difference.
check("D's every exit row equals A's, field for field",
  [systemStop("D"), protectivePolicy("D").stockThreshold, protectivePolicy("D").marketThreshold, protectivePolicy("D").buffer, partialProfitPolicy("D"), autoArmPolicy("D"), trailGivebackFor("D"), vectorExitThreshold("D"), systemCloseMinute("D"), closeReasonFor("D")],
  [systemStop("ANEW"), protectivePolicy("ANEW").stockThreshold, protectivePolicy("ANEW").marketThreshold, protectivePolicy("ANEW").buffer, partialProfitPolicy("ANEW"), autoArmPolicy("ANEW"), trailGivebackFor("ANEW"), vectorExitThreshold("ANEW"), systemCloseMinute("ANEW"), closeReasonFor("ANEW")]);
// The automatic arm resolves inside decideTick for both accounts, with the same patch.
const armA = tick("ANEW", pos({ partial_profit_taken: true }), 105, { halted: false });
const armD = tick("D", pos({ partial_profit_taken: true }), 105, { halted: false });
check("A and D decide a +$1,000 tick identically: same action, same two state writes (the +$500 trail arm, then the automatic arm at +$1,000)",
  [armA.action, armD.action, (armA.prior_patches || []).length, (armD.prior_patches || []).length, JSON.stringify(armA.prior_patches) === JSON.stringify(armD.prior_patches)],
  ["needs_vector", "needs_vector", 2, 2, true]);
// The ONE difference: same +$200 level, but A takes three rungs at a fixed $40,000 each
// and D takes a single rung sized from its buying power.
const pA = tick("ANEW", pos(), 101.25, { halted: false });
check("the difference is the rung count and the size: both press at +$200, A three times at $40,000, D once from buying power",
  [pA.event, pA.pl_raw, pA.press_size_usd, pA.shares_added, press1Threshold("ANEW"), press1Threshold("D"), pressPlan("ANEW"), pressPlan("D").single],
  ["press1", 250, 40000, 395, 200, 200, null, true]);
check("Vector Exit: A, B, C and D can never fire (101)", [vectorExitThreshold("C"), vectorExitThreshold("C_LEGACY"), vectorExitThreshold("D"), vectorExitThreshold("ANEW"), vectorExitThreshold("B")], [101, 101, 101, 101, 101]);

// --- 19. THE SESSION CLOSE, PER ACCOUNT ---------------------------------------
// Every account closes its book at 15:30 ET from the 2026-11-25 session and records
// close_1530 (the owner's direction, 2026-11-24): A, B, C and D, the same minute and the
// same reason. 2026-11-16 remains the one full-session exception A, C and D carry, where
// they run to the shared 16:00 and record close_1600.
const quiet = { partial_profit_taken: true, pressed_1r: true, pressed_2r: true, pressed_3r: true };
const at = (iso, system) => decideTick({ system, position: pos(quiet), price: 100.5, nowIso: iso });
check("session close per account: A, B, C and D all at 15:30 with close_1530",
  [systemCloseMinute("C"), systemCloseMinute("C_LEGACY"), systemCloseMinute("B"), systemCloseMinute("D"), systemCloseMinute("ANEW"), closeReasonFor("C"), closeReasonFor("B"), closeReasonFor("ANEW"), closeReasonFor("D")],
  [930, 930, 930, 930, 930, "close_1530", "close_1530", "close_1530", "close_1530"]);
// 20:29Z = 15:29 ET, 20:31Z = 15:31 ET on 2026-11-17 (EST).
check("B is still open at 15:29 and closed at 15:31 with close_1530",
  [at("2026-11-17T20:29:00.000Z", "B").action, at("2026-11-17T20:31:00.000Z", "B").action, at("2026-11-17T20:31:00.000Z", "B").exit_reason],
  ["hold", "exit", "close_1530"]);
check("A is still open at 15:29 and closed at 15:31 with close_1530",
  [at("2026-11-17T20:29:00.000Z", "ANEW").action, at("2026-11-17T20:31:00.000Z", "ANEW").action, at("2026-11-17T20:31:00.000Z", "ANEW").exit_reason],
  ["hold", "exit", "close_1530"]);
check("C and D are still open at 15:29 and closed at 15:31 with close_1530, exactly as A and B",
  [at("2026-11-17T20:29:00.000Z", "C").action, at("2026-11-17T20:31:00.000Z", "C").exit_reason, at("2026-11-17T20:29:00.000Z", "D").action, at("2026-11-17T20:31:00.000Z", "D").exit_reason],
  ["hold", "close_1530", "hold", "close_1530"]);
// The 13:30 close is gone: at 13:31 ET on 2026-11-17 every account still holds.
check("nobody closes at 13:31 any more — the book runs to 15:30",
  [at("2026-11-17T18:31:00.000Z", "C").action, at("2026-11-17T18:31:00.000Z", "D").action, at("2026-11-17T18:31:00.000Z", "ANEW").action, at("2026-11-17T18:31:00.000Z", "B").action],
  ["hold", "hold", "hold", "hold"]);
// 2026-11-16 — the one full-session exception A, C and D carry — still runs to 16:00.
// 20:31Z and 21:01Z are 15:31 and 16:01 ET on 2026-11-16 (EST).
check("on 2026-11-16 the exception holds: A, C and D close at 16:00 with close_1600",
  [at("2026-11-16T21:01:00.000Z", "C").exit_reason, at("2026-11-16T21:01:00.000Z", "ANEW").exit_reason, at("2026-11-16T21:01:00.000Z", "D").exit_reason],
  ["close_1600", "close_1600", "close_1600"]);
check("B carries no exception: it holds at 15:01 and closes at 15:30 on 2026-11-16",
  [at("2026-11-16T20:01:00.000Z", "B").action, at("2026-11-16T20:31:00.000Z", "B").exit_reason, at("2026-11-16T21:01:00.000Z", "B").exit_reason],
  ["hold", "close_1530", "close_1530"]);

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