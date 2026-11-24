// cProfit1400SelfTest.js — pins DART C's ONE Profit Protection rule, in force from the
// 2026-11-25 session.
//
//     node cProfit1400SelfTest.js
//
// C long 200 shares at $100.00 ($20,000 basis), every press already taken:
//   $107.00  P&L +$1,400 -> 25% (50 shares) sold AND the stop armed on the same print;
//            the stored high point is the remaining 150 shares' P&L, +$1,050
//   $108.00  remaining P&L +$1,200 -> no sale, no exit, high point +$1,200
//   $105.67  remaining P&L +$850.50 -> hold (the $350 giveback sits at +$850)
//   $105.66  remaining P&L +$849    -> exit, protective_stop
//
// No network, no database, no clock, no trading record. Exit code 0 = every case passes.

import { decideTick } from "./tickDecisionCore.js";
import {
  partialProfitPolicy, autoArmPolicy, protectivePolicy, systemStop,
  trailGivebackFor, priceTrailDisabledFor, systemCloseMinute,
} from "./tickRules.js";

const NOW = "2026-11-25T17:00:00.000Z"; // 12:00 ET, inside the session
const ALL_LOSS_LEVELS = Array.from({ length: 17 }, (_, i) => -100 * (i + 1));

const pos = (over) => ({
  id: "c1", status: "open", symbol: "TEST", side: "long",
  entry_time: "2026-11-25T15:30:00.000Z", entry_price: 100,
  shares: 200, tcb: 20000, peak_pl: 0,
  pressed_1r: true, pressed_2r: true, pressed_3r: true,
  protective_stop_active: false, price_trail_active: false, profit_grid_active: false,
  checked_loss_levels: ALL_LOSS_LEVELS, commission_fees: 0, presses: [],
  ...(over || {}),
});

const tick = (position, price, extra) =>
  decideTick({ system: "C", position, price, nowIso: NOW, vectorScore: 5, ...(extra || {}) });

const cases = [];
function check(name, actual, expected) {
  cases.push({ name, pass: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });
}

// --- THE ROWS ----------------------------------------------------------------
check("C sells 25% once at +$1,400", partialProfitPolicy("C"), { threshold: 1400, fraction: 0.25 });
check("C arms its stop at +$1,400, on the sale's own print", autoArmPolicy("C"), 1400);
check("C and C_LEGACY give back $350, thresholds 101/101", [
  protectivePolicy("C").stockThreshold, protectivePolicy("C").marketThreshold, protectivePolicy("C").buffer,
  protectivePolicy("C_LEGACY").stockThreshold, protectivePolicy("C_LEGACY").marketThreshold, protectivePolicy("C_LEGACY").buffer,
], [101, 101, 350, 101, 101, 350]);
check("C still has no trail of either kind", [
  trailGivebackFor("C"), trailGivebackFor("C_LEGACY"), priceTrailDisabledFor("C"), priceTrailDisabledFor("C_LEGACY"),
], [null, null, true, true]);
check("C keeps its hard stop and its 15:00 close", [systemStop("C"), systemCloseMinute("C")], [-1150, 900]);
check("A keeps its own +$850 sale, +$1,000 arm and $250 giveback", [
  partialProfitPolicy("ANEW"), autoArmPolicy("ANEW"), protectivePolicy("ANEW").buffer,
], [{ threshold: 850, fraction: 0.25 }, 1000, 250]);
check("B and D are untouched", [
  partialProfitPolicy("B"), autoArmPolicy("B"), protectivePolicy("B").buffer,
  partialProfitPolicy("D"), autoArmPolicy("D"), protectivePolicy("D").buffer,
], [{ threshold: 850, fraction: 0.25 }, null, 250, { threshold: 850, fraction: 0.25 }, 1000, 250]);

// --- PRINT 1: $107.00, +$1,400 — THE SALE AND THE ARM ON ONE PRINT -----------
const gridBefore = { profit_grid_active: true, last_profit_level: 900, next_up_profit_level: 1000, next_down_profit_level: 800 };
const p1 = tick(pos(gridBefore), 107.0);
check("print 1 $107.00 (+$1,400): 25% of 200 shares sold",
  [p1.action, p1.event, p1.sold_shares, p1.remaining_shares],
  ["partial", "partial_profit_exit", 50, 150]);
check("print 1: the stop arms on the same print",
  (p1.prior_patches || []).some((p) => p && p.protective_stop_active === true), true);
check("print 1: the stored high point is the remaining 150 shares' P&L",
  [p1.patch.protective_high_water_pl, p1.patch.shares, p1.patch.tcb],
  [1050, 150, 15000]);

// --- PRINT 2: $108.00, remaining +$1,200 --------------------------------------
const after1 = pos({
  shares: 150, tcb: 15000, partial_profit_taken: true,
  protective_stop_active: true, protective_high_water_pl: 1050, peak_pl: 1400,
  profit_grid_active: true, last_profit_level: 1000, next_up_profit_level: 1100, next_down_profit_level: 900,
});
const p2 = tick(after1, 108.0);
check("print 2 $108.00 (remaining +$1,200): nothing sold, nothing closed",
  [p2.sold_shares ?? null, p2.event === "protective_stop", p2.action === "partial", p2.action === "exit"],
  [null, false, false, false]);
check("print 2: the high point ratchets to +$1,200",
  (p2.prior_patches || []).find((p) => p && p.protective_high_water_pl != null)?.protective_high_water_pl, 1200);
check("print 2: the answer is the grid's own re-base, a state write and not a trade",
  [p2.action, p2.event], ["grid", "vector_profit_hold"]);

// --- PRINT 3: $105.67, remaining +$850.50 -------------------------------------
const after2 = pos({
  shares: 150, tcb: 15000, partial_profit_taken: true,
  protective_stop_active: true, protective_high_water_pl: 1200, peak_pl: 1400,
  profit_grid_active: true, last_profit_level: 1100, next_up_profit_level: 1200, next_down_profit_level: 1000,
});
const p3 = tick(after2, 105.67);
check("print 3 $105.67 (remaining +$850.50): the $350 giveback sits at +$850, so it holds",
  [p3.action === "exit", p3.event === "protective_stop"], [false, false]);

// --- PRINT 4: $105.66, remaining +$849 ----------------------------------------
const p4 = tick(after2, 105.66);
check("print 4 $105.66 (remaining +$849): the stop gives back $350 and closes it",
  [p4.action, p4.event], ["exit", "protective_stop"]);

// --- REPORT -------------------------------------------------------------------
let failed = 0;
for (const c of cases) {
  if (!c.pass) {
    failed++;
    console.log("FAIL  " + c.name);
    console.log("      expected " + JSON.stringify(c.expected));
    console.log("      actual   " + JSON.stringify(c.actual));
  }
}
console.log("");
console.log("DART C's +$1,400 Profit Protection from 2026-11-25: " + (cases.length - failed) + "/" + cases.length + " checks passed");
process.exit(failed === 0 ? 0 : 1);
