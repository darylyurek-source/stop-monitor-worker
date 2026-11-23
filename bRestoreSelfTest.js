// bRestoreSelfTest.js — pins DART B's rule set in force from the 2026-11-23 session (the
// owner's confirmed exit changes) on top of its 2026-11-19 restore.
//
//     node bRestoreSelfTest.js
//
// Every expected value below was derived by hand from the owner's written rules and then
// confirmed against this engine's own arithmetic. Exit code 0 = B resolves every one of its
// rows and every decision path; exit code 1 = the failing case names the rule that diverged.
// No network, no database, no clock, no trading record.
//
// A, C and D are checked here ONLY where B's rows could have reached them: each of their
// rows is asserted unchanged beside B's.
//
// B FROM 2026-11-23: Press 1/2/3 at +$250/+$500/+$800, Hard Loss Stop -$1,200 on one print,
// Profit Protection 25% once at +$1,400, the $350 giveback armed by itself at +$900, NO
// trailing stop and NO Vector Exit (neither the 65 exit nor the +$900 grid).

import { decideTick } from "./tickDecisionCore.js";
import {
  press1Threshold, press2Threshold, press3Threshold, systemStop, partialProfitPolicy,
  autoArmPolicy, protectivePolicy, vectorExitThreshold, systemCloseMinute, closeReasonFor,
  priceTrailDisabledFor, vectorExitFullyDisabled, HALTED_SYSTEMS,
} from "./tickRules.js";

const NOW = "2026-11-19T16:00:00.000Z";

const pos = (over) => ({
  id: "p1", status: "open", symbol: "TEST", side: "long",
  entry_time: "2026-11-19T15:30:00.000Z", entry_price: 100,
  shares: 200, tcb: 20000, peak_pl: 0,
  pressed_1r: false, pressed_2r: false, pressed_3r: false,
  protective_stop_active: false, price_trail_active: false,
  checked_loss_levels: [], profit_grid_active: false,
  commission_fees: 0, presses: [],
  ...(over || {}),
});

const allPressed = { pressed_1r: true, pressed_2r: true, pressed_3r: true };

const tick = (system, position, price, extra) =>
  decideTick({ system, position, price, nowIso: NOW, ...(extra || {}) });

const cases = [];
function check(name, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  cases.push({ name, pass, actual, expected });
}

// --- B'S OWN ROWS -------------------------------------------------------------
check("B presses at +$250 / +$500 / +$800",
  [press1Threshold("B"), press2Threshold("B"), press3Threshold("B")], [250, 500, 800]);
check("A, C and D keep +$200 / +$400 / +$1,100",
  [press1Threshold("ANEW"), press2Threshold("ANEW"), press3Threshold("ANEW"),
   press1Threshold("C"), press2Threshold("C"), press3Threshold("C"),
   press1Threshold("D"), press2Threshold("D"), press3Threshold("D")],
  [200, 400, 1100, 200, 400, 1100, 200, 400, 1100]);
check("B's hard loss stop is -$1,200; A -$400, C -$400, D -$400",
  [systemStop("B"), systemStop("ANEW"), systemStop("C"), systemStop("D")], [-1200, -400, -400, -400]);
check("B sells 25% once at +$1,400; A, C and D sell 25% at +$850",
  [partialProfitPolicy("B"), partialProfitPolicy("ANEW"), partialProfitPolicy("C"), partialProfitPolicy("D")],
  [{ threshold: 1400, fraction: 0.25 }, { threshold: 850, fraction: 0.25 },
   { threshold: 850, fraction: 0.25 }, { threshold: 850, fraction: 0.25 }]);
check("B arms by itself at +$900; A, C and D arm at +$1,000",
  [autoArmPolicy("B"), autoArmPolicy("ANEW"), autoArmPolicy("C"), autoArmPolicy("D")], [900, 1000, 1000, 1000]);
check("B's Vector arming is removed: 101 / 101 with a $350 giveback",
  [protectivePolicy("B").stockThreshold, protectivePolicy("B").marketThreshold, protectivePolicy("B").buffer],
  [101, 101, 350]);
check("B's Vector Exit is removed: threshold 101", vectorExitThreshold("B"), 101);
check("B's trail and Vector Exit are disabled as mechanisms",
  [priceTrailDisabledFor("B"), vectorExitFullyDisabled("B")], [true, true]);
check("B closes at 15:30 ET as close_1530; A closes at 15:00 as close_1500",
  [systemCloseMinute("B", null), closeReasonFor("B"), systemCloseMinute("ANEW", null), closeReasonFor("ANEW")],
  [930, "close_1530", 900, "close_1500"]);
check("B is not halted", HALTED_SYSTEMS.includes("B"), false);

// --- B'S DECISIONS ------------------------------------------------------------
// 200 sh at $100.00 (tcb $20,000): P&L is $200 per $1.00 of price.
const underPress = tick("B", pos(), 101.245, { vectorScore: 5 });
check("B holds just under its +$250 Press 1", underPress.action, "hold");
const press1 = tick("B", pos(), 101.25, { vectorScore: 5 });
check("B presses at +$250: $40,000 / $101.25 = 395 shares, tcb $59,993.75",
  [press1.action, press1.event, press1.shares_added, press1.patch.tcb],
  ["press", "press1", 395, 59993.75]);
check("Press 1 does NOT arm a trail on B",
  press1.patch.price_trail_active ?? null, null);

// 596 sh, tcb $59,996: the price that puts P&L at $500 is (59,996 + 500) / 596.
const rung2 = pos({ pressed_1r: true, shares: 596, tcb: 59996, peak_pl: 400 });
check("B holds just under its +$500 Press 2", tick("B", rung2, (59996 + 499) / 596, { vectorScore: 5 }).action, "hold");
const press2 = tick("B", rung2, (59996 + 500.5) / 596, { vectorScore: 5 });
check("B presses at +$500", press2.event, "press2");
check("Press 2 does NOT arm a trail on B", press2.patch.price_trail_active ?? null, null);
// 992 sh, tcb $99,992: the price that puts P&L at $800 is (99,992 + 800) / 992.
const rung3 = pos({ pressed_1r: true, pressed_2r: true, shares: 992, tcb: 99992, peak_pl: 800 });
check("B presses at +$800", tick("B", rung3, (99992 + 800.5) / 992, { vectorScore: 5 }).event, "press3");

check("B's hard loss stop closes at -$1,200 on one print",
  [tick("B", pos(), 94.0, { vectorScore: 5 }).action,
   tick("B", pos(), 94.0, { vectorScore: 5 }).event,
   tick("B", pos(), 94.0, { vectorScore: 5 }).gross_pl],
  ["exit", "realtime_stop_close", -1200]);
check("B holds just above -$1,200", tick("B", pos(), 94.01, { vectorScore: 5 }).action, "hold");

// 200 sh, tcb $20,000: +$1,400 sits at $107.00 — 25% of the shares held (50 of 200) are sold.
const at1400 = tick("B", pos({ ...allPressed, peak_pl: 1400 }), 107.0, { vectorScore: 5 });
check("B sells 25% at +$1,400: 50 of 200 shares",
  [at1400.action, at1400.event, at1400.sold_shares, at1400.remaining_shares],
  ["partial", "partial_profit_exit", 50, 150]);
check("B takes no sale just under +$1,400",
  tick("B", pos({ ...allPressed, peak_pl: 1398 }), 106.99, { vectorScore: 5 }).action, "hold");

// 200 sh, tcb $20,000: +$900 sits at $104.50. B's arming row is applied by the tick wrapper
// (engineShadow.decide), not by this portable core, exactly as it always was for B — what
// this core must prove is that no grid and no press sits in the way above +$900.
const armTick = tick("B", pos({ ...allPressed, peak_pl: 899 }), 104.5, { vectorScore: 5 });
check("B's +$900 level holds with no grid state and no press above it",
  [armTick.action, armTick.patch.profit_grid_active ?? null], ["hold", null]);

// Armed at a $1,300 high-water: the stop sits at 1,300 - 350 = $950 of P&L.
const armedPos = { ...allPressed, protective_stop_active: true, protective_high_water_pl: 1300 };
check("B's armed stop closes on a $350 giveback",
  [tick("B", pos(armedPos), 104.75, { vectorScore: 5 }).action,
   tick("B", pos(armedPos), 104.75, { vectorScore: 5 }).event,
   tick("B", pos(armedPos), 104.75, { vectorScore: 5 }).gross_pl],
  ["exit", "protective_stop", 950]);
check("B holds above the giveback", tick("B", pos(armedPos), 104.76, { vectorScore: 5 }).action, "hold");

// 200 sh, tcb $20,000: -$600 sits at $97.00 — a perfect Vector score must still not close B.
const vecAtLoss = tick("B", pos({ ...allPressed }), 97.0, { vectorScore: 100 });
check("no Vector score can close B (100 at -$600 is a hold)",
  [vecAtLoss.action, vecAtLoss.patch.vector_checkpoints ?? null], ["hold", null]);

check("B is still open at 15:29 ET",
  decideTick({ system: "B", position: pos(), price: 101, nowIso: "2026-11-19T20:29:00.000Z" }).action, "hold");
check("B closes at 15:30 ET as close_1530",
  decideTick({ system: "B", position: pos(), price: 101, nowIso: "2026-11-19T20:31:00.000Z" }).event, "close_1530");
check("A still closes at 15:00 ET as close_1500",
  decideTick({ system: "ANEW", position: pos(), price: 101, nowIso: "2026-11-19T20:01:00.000Z" }).event, "close_1500");


// --- OFFICIAL EARLY CLOSES (1:00 PM ET) ---------------------------------------
const atEarly = (system, iso) => decideTick({ system, position: pos(), price: 101, nowIso: iso });
for (const iso of ["2026-11-27T18:01:00.000Z", "2026-12-24T18:01:00.000Z"]) {
  check("all four close at 13:00 ET on " + iso.slice(0, 10) + " (early close)",
    ["ANEW", "B", "C", "D"].map((s) => atEarly(s, iso).event),
    ["close_1300", "close_1300", "close_1300", "close_1300"]);
  check("all four hold at 12:59 ET on " + iso.slice(0, 10),
    ["ANEW", "B", "C", "D"].map((s) => atEarly(s, iso.replace("T18:01", "T17:59")).action),
    ["hold", "hold", "hold", "hold"]);
}
check("a normal day is unchanged: A/C/D 15:00, B 15:30",
  [atEarly("ANEW", "2026-11-24T20:01:00.000Z").event, atEarly("B", "2026-11-24T20:01:00.000Z").action,
   atEarly("B", "2026-11-24T20:31:00.000Z").event, atEarly("C", "2026-11-24T20:01:00.000Z").event,
   atEarly("D", "2026-11-24T20:01:00.000Z").event],
  ["close_1500", "hold", "close_1530", "close_1500", "close_1500"]);

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
console.log("DART B rules from 2026-11-23: " + (cases.length - failed) + "/" + cases.length + " checks passed");
process.exit(failed === 0 ? 0 : 1);
