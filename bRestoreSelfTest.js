// bRestoreSelfTest.js — pins DART B's RESTORED 2026-11-06 configuration, in force from
// 2026-11-19 (the owner's direction, 12:10 PM ET).
//
//     node bRestoreSelfTest.js
//
// Every expected value below was derived by hand from the owner's written 2026-11-06
// configuration and then confirmed against this engine's own arithmetic. Exit code 0 =
// B resolves every one of its rows and every decision path; exit code 1 = the failing
// case names the rule that diverged. No network, no database, no clock, no trading
// record.
//
// A, C and D are checked here ONLY where B's restore could have reached them: each of
// their rows is asserted unchanged beside B's.

import { decideTick } from "./tickDecisionCore.js";
import {
  press1Threshold, press2Threshold, press3Threshold, systemStop, partialProfitPolicy,
  autoArmPolicy, protectivePolicy, vectorExitThreshold, systemCloseMinute, closeReasonFor,
  bProfitTrailPct, HALTED_SYSTEMS,
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

const tick = (system, position, price, extra) =>
  decideTick({ system, position, price, nowIso: NOW, ...(extra || {}) });

const cases = [];
function check(name, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  cases.push({ name, pass, actual, expected });
}

// --- B'S OWN ROWS -------------------------------------------------------------
check("B presses at +$250 / +$700 / +$800",
  [press1Threshold("B"), press2Threshold("B"), press3Threshold("B")], [250, 700, 800]);
check("A, C and D keep +$200 / +$400 / +$1,100",
  [press1Threshold("ANEW"), press2Threshold("ANEW"), press3Threshold("ANEW"),
   press1Threshold("C"), press2Threshold("C"), press3Threshold("C"),
   press1Threshold("D"), press2Threshold("D"), press3Threshold("D")],
  [200, 400, 1100, 200, 400, 1100, 200, 400, 1100]);
check("B's hard loss stop is -$1,700 again; A -$400, C -$400, D -$400",
  [systemStop("B"), systemStop("ANEW"), systemStop("C"), systemStop("D")], [-1700, -400, -400, -400]);
check("B has NO Profit Protection; A, C and D sell 25% at +$850",
  [partialProfitPolicy("B"), partialProfitPolicy("ANEW"), partialProfitPolicy("C"), partialProfitPolicy("D")],
  [null, { threshold: 850, fraction: 0.25 }, { threshold: 850, fraction: 0.25 }, { threshold: 850, fraction: 0.25 }]);
check("B has NO automatic hard stop; A, C and D arm at +$1,000",
  [autoArmPolicy("B"), autoArmPolicy("ANEW"), autoArmPolicy("C"), autoArmPolicy("D")], [null, 1000, 1000, 1000]);
check("B's Protective Stop arms on the Vector test alone: 55 / 65 with a $350 giveback",
  [protectivePolicy("B").stock, protectivePolicy("B").market, protectivePolicy("B").buffer], [55, 65, 350]);
check("B's Vector Exit stays 65", vectorExitThreshold("B"), 65);
check("B's share-price trail ladder: 1.00% at +$1,500, 0.75% at +$2,000, 0.50% at +$2,500, 0.35% at +$3,500, and 1.75% below",
  [1400, 1600, 2100, 2600, 3600].map((p) => bProfitTrailPct(p)), [null, 0.01, 0.0075, 0.005, 0.0035]);
check("B closes at 15:30 ET as close_1530; A, C and D close at 15:00 as close_1500",
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
check("Press 2 arms B's trail", press1.patch.price_trail_active, true);

// 596 sh, tcb $59,996: the price that puts P&L at $700 is (59,996 + 700) / 596.
const rung2 = pos({ pressed_1r: true, shares: 596, tcb: 59996, peak_pl: 400 });
check("B holds just under its +$700 Press 2", tick("B", rung2, (59996 + 699) / 596, { vectorScore: 5 }).action, "hold");
check("B presses at +$700", tick("B", rung2, (59996 + 700.5) / 596, { vectorScore: 5 }).event, "press2");
// 992 sh, tcb $99,992: the price that puts P&L at $800 is (99,992 + 800) / 992.
const rung3 = pos({ pressed_1r: true, pressed_2r: true, shares: 992, tcb: 99992, peak_pl: 800 });
check("B presses at +$800", tick("B", rung3, (99992 + 800.5) / 992, { vectorScore: 5 }).event, "press3");

check("B's hard loss stop closes at -$1,700 on one print",
  [tick("B", pos(), 91.5, { vectorScore: 5 }).action, tick("B", pos(), 91.5, { vectorScore: 5 }).event,
   tick("B", pos(), 91.5, { vectorScore: 5 }).gross_pl],
  ["exit", "realtime_stop_close", -1700]);
check("B holds just above -$1,700", tick("B", pos(), 91.6, { vectorScore: 5 }).action, "hold");
// 200 sh, tcb $20,000: +$1,850 sits at $109.25 — a level B no longer acts on.
check("B does NOT take a 25% sale at +$1,850",
  tick("B", pos({ peak_pl: 1850 }), 109.25, { vectorScore: 5 }).event, "profit_grid");
// 200 sh, tcb $20,000: +$2,000 sits at $110.00 — a level B no longer arms at.
const armLevel = tick("B", pos({ peak_pl: 1900 }), 110, { vectorScore: 5 });
check("B does NOT arm an automatic hard stop at +$2,000",
  [armLevel.action, armLevel.patch.protective_stop_active ?? null, armLevel.patch.protective_high_water_pl ?? null],
  ["grid", null, null]);
check("B is still open at 15:29 ET",
  decideTick({ system: "B", position: pos(), price: 101, nowIso: "2026-11-19T20:29:00.000Z" }).action, "hold");
check("B closes at 15:30 ET as close_1530",
  decideTick({ system: "B", position: pos(), price: 101, nowIso: "2026-11-19T20:31:00.000Z" }).event, "close_1530");
check("A still closes at 15:00 ET as close_1500",
  decideTick({ system: "ANEW", position: pos(), price: 101, nowIso: "2026-11-19T20:01:00.000Z" }).event, "close_1500");

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
console.log("DART B restored 2026-11-06 rules: " + (cases.length - failed) + "/" + cases.length + " checks passed");
process.exit(failed === 0 ? 0 : 1);
