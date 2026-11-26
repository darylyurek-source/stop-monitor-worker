// dCloneSelfTest.js — DART D IS AN EXACT, INDEPENDENT REPLICA OF DART C (2026-11-26).
//
// 1. ROWS: every rule D resolves equals C's EFFECTIVE row — C's own name for the presses,
//    Profit Protection and the automatic arm; C_LEGACY (where every C position resolves through
//    ruleKeyFor) for the hard stop, the Protective Stop, the trail, the Vector Exit and the close.
// 2. INDEPENDENCE: D's rows are D's own values and objects, never references to C's.
// 3. BEHAVIOUR: the same deterministic grid of positions and prints is fed to decideTick as "C"
//    and as "D", and every verdict must be identical once the system name is removed.
//
// Pure: no network, no clock, no writes. Run: node dCloneSelfTest.js
import { decideTick } from "./tickDecisionCore.js";
import * as R from "./tickRules.js";

const cases = [];
const check = (name, actual, expected) => cases.push({ name, pass: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });

// --- 1. rows -------------------------------------------------------------------
const cEff = {
  press1: R.press1Threshold("C"), press2: R.press2Threshold("C"), press3: R.press3Threshold("C"), plan: R.pressPlan("C"),
  partial: R.partialProfitPolicy("C"), autoArm: R.autoArmPolicy("C"),
  hardStop: R.systemStop("C_LEGACY"), protective: R.protectivePolicy("C_LEGACY"), trailGiveback: R.trailGivebackFor("C_LEGACY"),
  trailOff: R.priceTrailDisabledFor("C_LEGACY"), vecExit: R.vectorExitThreshold("C_LEGACY"), vecOff: R.vectorExitFullyDisabled("C_LEGACY"),
  close: R.systemCloseMinute("C_LEGACY"), closeReason: R.closeReasonFor("C_LEGACY"),
};
const dRow = {
  press1: R.press1Threshold("D"), press2: R.press2Threshold("D"), press3: R.press3Threshold("D"), plan: R.pressPlan("D"),
  partial: R.partialProfitPolicy("D"), autoArm: R.autoArmPolicy("D"),
  hardStop: R.systemStop(R.ruleKeyFor("D", {})), protective: R.protectivePolicy(R.ruleKeyFor("D", {})), trailGiveback: R.trailGivebackFor("D"),
  trailOff: R.priceTrailDisabledFor("D"), vecExit: R.vectorExitThreshold("D"), vecOff: R.vectorExitFullyDisabled("D"),
  close: R.systemCloseMinute("D"), closeReason: R.closeReasonFor("D"),
};
for (const k of Object.keys(cEff)) check(`row ${k}: D equals C`, dRow[k], cEff[k]);
check("the owner's figures: +$225 / +$350 / +$1,100 at $40,000, -$1,150, 25% at +$1,400, arm +$1,400 with $350, Protective off, Vector Exit off, no trail",
  [dRow.press1, dRow.press2, dRow.press3, R.PRESS_SIZE_USD, dRow.hardStop, dRow.partial, dRow.autoArm, dRow.protective.buffer,
   dRow.protective.stockThreshold, dRow.protective.marketThreshold, dRow.vecExit, dRow.trailGiveback, dRow.trailOff],
  [225, 350, 1100, 40000, -1150, { threshold: 1400, fraction: 0.25 }, 1400, 350, 101, 101, 101, null, true]);

// --- 2. independence -------------------------------------------------------------
check("D's protective row is its own object", R.protectivePolicy("D") !== R.protectivePolicy("C_LEGACY"), true);
check("D's Profit Protection row is its own object", R.SYSTEM_PARTIAL_PROFIT.D !== R.SYSTEM_PARTIAL_PROFIT.C, true);
check("D's Press 2 and Press 3 are D's own constants", [R.D_PRESS2, R.D_PRESS3], [350, 1100]);
check("D resolves its own rule key", R.ruleKeyFor("D", {}), "D");

// --- 3. behaviour ----------------------------------------------------------------
const base = { id: "p1", status: "open", symbol: "TEST", entry_time: "2026-11-25T15:35:00.000Z", entry_price: 100, shares: 200, tcb: 20000,
  peak_pl: 0, pressed_1r: false, pressed_2r: false, pressed_3r: false, protective_stop_active: false, price_trail_active: false,
  checked_loss_levels: [], profit_grid_active: false, commission_fees: 0, presses: [], partial_exits: [] };
const states = [
  {}, { pressed_1r: true, shares: 600, tcb: 60090 }, { pressed_1r: true, pressed_2r: true, shares: 1000, tcb: 100300 },
  { pressed_1r: true, pressed_2r: true, pressed_3r: true, shares: 1400, tcb: 140800 },
  { protective_stop_active: true, protective_high_water_pl: 1500, peak_pl: 1500, shares: 600, tcb: 60090, pressed_1r: true },
  { partial_profit_taken: true, peak_pl: 1450, shares: 450, tcb: 45000 },
  { price_trail_active: true, peak_pl: 900 },
];
const times = ["2026-11-25T15:40:00.000Z", "2026-11-25T20:29:00.000Z", "2026-11-25T20:30:30.000Z", "2026-11-27T17:59:00.000Z", "2026-11-27T18:00:30.000Z"];
const strip = (v) => JSON.stringify(v, (k, x) => (k === "system" ? undefined : x));
let n = 0, differ = 0, first = null;
for (const side of ["long", "short"]) for (const st of states) for (const t of times)
  for (let dp = -14; dp <= 14; dp += 0.25) for (const conf of [null, { pending: false }, { pending: true }]) for (const vs of [null, 0, 50, 100]) {
    const position = { ...base, side, ...st };
    const price = 100 + (side === "long" ? dp : -dp) * (200 / position.shares);
    const a = { position, price, nowIso: t, vectorScore: vs ?? undefined, hardStopConfirm: conf ?? undefined };
    const c = strip(decideTick({ ...a, system: "C" })), d = strip(decideTick({ ...a, system: "D" }));
    n++; if (c !== d) { differ++; if (!first) first = { side, st, t, dp, conf, vs }; }
  }
check(`behaviour: ${n} identical ticks through C and D`, { differ, first }, { differ: 0, first: null });

const failed = cases.filter((c) => !c.pass);
for (const c of cases) console.log(`${c.pass ? "ok  " : "FAIL"}  ${c.name}${c.pass ? "" : `\n      expected ${JSON.stringify(c.expected)}\n      actual   ${JSON.stringify(c.actual)}`}`);
console.log(`\nDART D as C's replica: ${cases.length - failed.length}/${cases.length} checks passed`);
process.exit(failed.length ? 1 : 0);
