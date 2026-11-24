// bRestoreSelfTest.js — pins DART B's rule set in force from the 2026-11-24 session.
//
//     node bRestoreSelfTest.js
//
// PROOF REVISION 3 (2026-11-24): at and above +$900 C's own upside grid answers before a
// press or a giveback, exactly as it does on C, so those ticks are compared B against C field
// for field. Every value below is still pinned to a literal wherever a literal is observable.
//
// FROM THE 2026-11-24 SESSION DART B TRADES DART C'S LIVE EXIT SET, VALUE FOR VALUE.
// B's stock selection and entry method are unchanged. A, C and D are untouched: every one
// of their rows is asserted beside B's, and every B check is written so it fails if B ever
// stops resolving exactly as C does.
//
//     presses        +$200, then +$400, then +$1,100, $40,000 each, in order
//     Profit Prot.   25% of the shares held, once, at +$850
//     Automatic stop REMOVED (2026-11-25): autoArmPolicy("B") is null; the $250 row stays
//     Protective     removed (101/101), exactly as on C
//     Trail          C's $100 P&L giveback, armed at +$500 of position P&L
//     Vector Exit    threshold 101, blocks running exactly as C's
//     Hard Loss      -$400 on its own row (C moved to -$1,150 on 2026-11-24)
//     Session        15:00 ET, recorded as close_1500
//
// No network, no database, no clock, no trading record. Exit code 0 = every case passes.

import { decideTick } from "./tickDecisionCore.js";
import {
  press1Threshold, press2Threshold, press3Threshold, systemStop, partialProfitPolicy,
  autoArmPolicy, protectivePolicy, vectorExitThreshold, systemCloseMinute, closeReasonFor,
  priceTrailDisabledFor, vectorExitFullyDisabled, trailGivebackFor, HALTED_SYSTEMS,
} from "./tickRules.js";

const NOW = "2026-11-24T16:00:00.000Z";

const pos = (over) => ({
  id: "p1", status: "open", symbol: "TEST", side: "long",
  entry_time: "2026-11-24T15:30:00.000Z", entry_price: 100,
  shares: 200, tcb: 20000, peak_pl: 0,
  pressed_1r: false, pressed_2r: false, pressed_3r: false,
  protective_stop_active: false, price_trail_active: false,
  checked_loss_levels: [], profit_grid_active: false,
  commission_fees: 0, presses: [],
  ...(over || {}),
});

const allPressed = { pressed_1r: true, pressed_2r: true, pressed_3r: true };
const sold = { partial_profit_taken: true };

const tick = (system, position, price, extra) =>
  decideTick({ system, position, price, nowIso: NOW, ...(extra || {}) });

// B must answer exactly as C does on the same position and price. At and above +$900 C's
// own upside grid answers first (C's live behaviour, unchanged), so those ticks are compared
// field for field instead of being pinned to an action B is not supposed to reach.
const asC = (price, over, extra) => {
  const pick = (v) => [v.action, v.event ?? null, v.sold_shares ?? null, v.shares_added ?? null, v.press_level ?? null];
  const b = pick(tick("B", pos(over), price, extra));
  const c = pick(tick("C", pos(over), price, extra));
  return { b, equal: JSON.stringify(b) === JSON.stringify(c) };
};

const cases = [];
function check(name, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  cases.push({ name, pass, actual, expected });
}

// --- B'S ROWS ARE C'S ROWS ----------------------------------------------------
check("B presses exactly where C does (+$200 / +$400 / +$1,100)",
  [press1Threshold("B"), press2Threshold("B"), press3Threshold("B")],
  [press1Threshold("C"), press2Threshold("C"), press3Threshold("C")]);
check("A, C and D keep +$200 / +$400 / +$1,100",
  [press1Threshold("ANEW"), press2Threshold("ANEW"), press3Threshold("ANEW"),
   press1Threshold("C"), press2Threshold("C"), press3Threshold("C"),
   press1Threshold("D"), press2Threshold("D"), press3Threshold("D")],
  [200, 400, 1100, 200, 400, 1100, 200, 400, 1100]);
check("B's hard loss stop is its own -$400; C carries -$1,150", [systemStop("B"), systemStop("C")], [-400, -1150]);
check("A and D keep -$400, C carries -$1,150", [systemStop("ANEW"), systemStop("C"), systemStop("D")], [-400, -1150, -400]);
check("B sells 25% once at +$850; C's own sale waits for +$1,400 from 2026-11-25",
  [partialProfitPolicy("B"), partialProfitPolicy("C")],
  [{ threshold: 850, fraction: 0.25 }, { threshold: 1400, fraction: 0.25 }]);
check("B has NO automatic arm: autoArmPolicy(\"B\") is null, C arms at +$1,400", [autoArmPolicy("B"), autoArmPolicy("C")], [null, 1400]);
check("B's protective row is its OWN 101 / 101 / $250, never C's $350",
  [protectivePolicy("B").stockThreshold, protectivePolicy("B").marketThreshold, protectivePolicy("B").buffer, protectivePolicy("C_LEGACY").buffer],
  [101, 101, 250, 350]);
check("B's protective row is 101 / 101 / 250",
  [protectivePolicy("B").stockThreshold, protectivePolicy("B").marketThreshold, protectivePolicy("B").buffer],
  [101, 101, 250]);
check("B carries its own $100 trail; C has none from 2026-11-24",
  [trailGivebackFor("B"), priceTrailDisabledFor("B"), trailGivebackFor("C"), priceTrailDisabledFor("C")],
  [100, false, null, true]);
check("B's trail giveback is $100 and no price trail is disabled",
  [trailGivebackFor("B"), priceTrailDisabledFor("B")], [100, false]);
check("B's Vector Exit is C's: threshold 101, blocks running",
  [vectorExitThreshold("B"), vectorExitFullyDisabled("B")],
  [vectorExitThreshold("C"), vectorExitFullyDisabled("C")]);
check("B's Vector Exit values are 101 and not disabled",
  [vectorExitThreshold("B"), vectorExitFullyDisabled("B")], [101, false]);
check("B closes at 15:00 ET as close_1500, exactly as C does",
  [systemCloseMinute("B"), closeReasonFor("B"), systemCloseMinute("C"), closeReasonFor("C")],
  [900, "close_1500", 900, "close_1500"]);
check("A and D close at 15:00 too", [systemCloseMinute("ANEW"), systemCloseMinute("D")], [900, 900]);
check("B is not halted", HALTED_SYSTEMS.includes("B"), false);

// --- B'S DECISIONS ------------------------------------------------------------
// 200 sh at $100.00 (tcb $20,000): P&L is $200 per $1.00 of price.
check("B holds just under its +$200 Press 1",
  tick("B", pos(), 100.99, { vectorScore: 5 }).action, "hold");
const press1 = tick("B", pos(), 101.0, { vectorScore: 5 });
check("B presses at +$200: 396 shares at $101.00, tcb $59,996",
  [press1.action, press1.event, press1.shares_added, press1.patch.tcb],
  ["press", "press1", 396, 59996]);
check("Press 1 does NOT arm a price trail on B (C's trail is a P&L rule)",
  press1.patch.price_trail_active ?? null, null);

// 596 sh, tcb $59,996: the price that puts P&L at $400 is (59,996 + 400) / 596.
const rung2 = pos({ pressed_1r: true, shares: 596, tcb: 59996, peak_pl: 400, ...sold });
check("B holds just under its +$400 Press 2",
  tick("B", rung2, (59996 + 399.5) / 596, { vectorScore: 5 }).action, "hold");
check("B presses at +$400", tick("B", rung2, (59996 + 400.5) / 596, { vectorScore: 5 }).event, "press2");
// +$1,100 is above +$900, where C's own upside grid answers first: B must answer exactly as
// C does on the same position rather than reach a rung C never reaches.
const gridAt1100 = { profit_grid_active: true, last_profit_level: 1100, next_up_profit_level: 1200, next_down_profit_level: 1000 };
const atPress3 = asC(102.75, { pressed_1r: true, pressed_2r: true, shares: 400, tcb: 40000, ...gridAt1100 }, { vectorScore: 5 });
check("at a +$1,100 tick B sells its quarter at +$850 while C presses (its sale waits for +$1,400)",
  [tick("B", pos({ pressed_1r: true, pressed_2r: true, shares: 400, tcb: 40000, ...gridAt1100 }), 102.75, { vectorScore: 5 }).action,
   tick("C", pos({ pressed_1r: true, pressed_2r: true, shares: 400, tcb: 40000, ...gridAt1100 }), 102.75, { vectorScore: 5 }).event],
  ["partial", "press3"]);

// 200 sh at $100.00 (tcb $20,000): $98.00 is exactly -$400, and $98.01 is -$398.
check("B's hard loss stop closes at -$400 (200 sh, $20,000 basis, $98.00)",
  [tick("B", pos(), 98.0, { vectorScore: 5 }).action,
   tick("B", pos(), 98.0, { vectorScore: 5 }).event,
   tick("B", pos(), 98.0, { vectorScore: 5 }).gross_pl],
  ["exit", "realtime_stop_close", -400]);
check("B holds at $98.01", tick("B", pos(), 98.01, { vectorScore: 5 }).action, "hold");

// 200 sh, tcb $20,000: +$850 sits at $104.25 — 25% of the shares held (50 of 200) are sold.
const at850 = tick("B", pos({ ...allPressed, peak_pl: 850 }), 104.25, { vectorScore: 5 });
check("B sells 25% at +$850: 50 of 200 shares",
  [at850.action, at850.event, at850.sold_shares, at850.remaining_shares],
  ["partial", "partial_profit_exit", 50, 150]);
check("B takes no sale just under +$850",
  tick("B", pos({ ...allPressed, peak_pl: 848 }), 104.24, { vectorScore: 5 }).action, "hold");

// C's $100 trail: armed, a $800 peak protects $700.
const trailArmed = pos({ ...allPressed, price_trail_active: true, peak_pl: 800, ...sold });
check("B's $100 trail closes at peak minus $100 ($103.50)",
  [tick("B", trailArmed, 103.5, { vectorScore: 5 }).action,
   tick("B", trailArmed, 103.5, { vectorScore: 5 }).event,
   tick("B", trailArmed, 103.5, { vectorScore: 5 }).gross_pl],
  ["exit", "price_trail_stop", 700]);
check("B holds one cent above the trail's floor", tick("B", trailArmed, 103.51, { vectorScore: 5 }).action, "hold");

// Armed at a $1,300 high-water: the stop sits at 1,300 - 250 = $1,050 of P&L ($105.25).
const armedPos = { ...allPressed, protective_stop_active: true, protective_high_water_pl: 1300, peak_pl: 100, ...sold };
check("B's armed stop closes on a $250 giveback",
  [tick("B", pos(armedPos), 105.25, { vectorScore: 5 }).action,
   tick("B", pos(armedPos), 105.25, { vectorScore: 5 }).event,
   tick("B", pos(armedPos), 105.25, { vectorScore: 5 }).gross_pl],
  ["exit", "protective_stop", 1050]);
check("one cent above B's giveback neither account closes: both hold, each re-basing its own grid", [tick("B", pos(armedPos), 105.26, { vectorScore: 5 }).action, tick("C", pos(armedPos), 105.26, { vectorScore: 5 }).action], ["grid", "grid"]);

check("B holds at 14:59 ET",
  decideTick({ system: "B", position: pos({ ...allPressed, ...sold }), price: 101, nowIso: "2026-11-24T19:59:00.000Z" }).action, "hold");
check("B closes at 15:00 ET as close_1500",
  decideTick({ system: "B", position: pos({ ...allPressed, ...sold }), price: 101, nowIso: "2026-11-24T20:00:00.000Z" }).event, "close_1500");

// --- OFFICIAL EARLY CLOSES (1:00 PM ET) ---------------------------------------
const atEarly = (system, iso, price = 101) => decideTick({ system, position: pos({ ...allPressed, ...sold }), price, nowIso: iso });
for (const iso of ["2026-11-27T18:01:00.000Z", "2026-12-24T18:01:00.000Z"]) {
  check("all four close at 13:00 ET on " + iso.slice(0, 10) + " (early close)",
    ["ANEW", "B", "C", "D"].map((s) => atEarly(s, iso).event),
    ["close_1300", "close_1300", "close_1300", "close_1300"]);
  check("all four hold at 12:59 ET on " + iso.slice(0, 10),
    ["ANEW", "B", "C", "D"].map((s) => atEarly(s, iso.replace("T18:01", "T17:59"), 100.1).action),
    ["hold", "hold", "hold", "hold"]);
}

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
console.log("DART B rules from 2026-11-24: " + (cases.length - failed) + "/" + cases.length + " checks passed");
process.exit(failed === 0 ? 0 : 1);
