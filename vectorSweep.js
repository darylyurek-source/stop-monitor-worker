// vectorSweep.js — READ-ONLY threshold sweep on the engine's own rule modules.
//
//   node vectorSweep.js <data-dir>
//
// It replays every recorded trade in <data-dir>/trades.json through the SAME two
// functions a live tick runs — protectiveTrigger.assessProtectiveTrigger and
// tickDecisionCore.decideTick — with the 1-minute bars for that symbol and session
// in <data-dir>/candles/<SYMBOL>_<date>.json and SPY in <data-dir>/spy_<date>.json.
// Each bar is offered twice, at its adverse extreme and at its close, exactly as the
// replay engine does.
//
// Only three numbers move: DART C's two arming thresholds (PROTECTIVE_BY_SYSTEM.C)
// and its Vector Exit threshold (VECTOR_EXIT_BY_SYSTEM.C). They are mutated in THIS
// process only — the objects are the ones the worker's own rule modules read, so the
// presses, the giveback, the $2,000 auto-arm, the trail, the profit sale, the hard
// stop and the 4:00 PM close are the engine's own code, untouched.
//
// It opens no socket, reads no clock and WRITES NOTHING: no position, no order, no
// entity. Its output is a table on stdout and one JSON file in the data directory.

import fs from "node:fs";
import path from "node:path";
import { PROTECTIVE_BY_SYSTEM, VECTOR_EXIT_BY_SYSTEM } from "./tickRules.js";
import { assessProtectiveTrigger } from "./protectiveTrigger.js";
import { computeStockVector, computeMarketVector } from "./vectorCore.js";
import { decideTick } from "./tickDecisionCore.js";

const DATA = process.argv[2] || "/tmp/vsweep";
const CANDLE_DIR = path.join(DATA, "candles");

const toCandle = (b) => ({ timestamp: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v || 0 });
const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const dateOf = (iso) => String(iso).slice(0, 10);

// --- load every trade with its bars -----------------------------------------
const trades = readJson(path.join(DATA, "trades.json")).filter(
  (t) => !/reset/i.test(String(t.exit_reason || ""))
);
const spyCache = {};
const spyFor = (date, side) => {
  const key = date + "|" + side;
  if (spyCache[key]) return spyCache[key];
  const file = path.join(DATA, `spy_${date}.json`);
  if (!fs.existsSync(file)) return (spyCache[key] = null);
  const candles = readJson(file).map(toCandle);
  // One market score per bar index: SPY's own 9:30 open is the reference.
  const scores = candles.map((_, i) => {
    const v = computeMarketVector(candles.slice(0, i + 1), side);
    return v ? Number(v.combined_reversal_score) : null;
  });
  return (spyCache[key] = { candles, scores });
};

const prepared = [];
for (const t of trades) {
  const date = dateOf(t.entry_time);
  const file = path.join(CANDLE_DIR, `${t.symbol}_${date}.json`);
  if (!fs.existsSync(file)) continue;
  const bars = readJson(file).map(toCandle);
  const entryMs = Date.parse(t.entry_time);
  let entryIdx = bars.findIndex((b) => b.timestamp + 60000 > entryMs);
  if (entryIdx < 0) continue;
  const spy = spyFor(date, t.side);
  if (!spy) continue;

  const shares = Number(t.initial_shares || t.shares) || 0;
  if (!(shares > 0) || !(Number(t.entry_price) > 0)) continue;

  // The stock Vector does not depend on any threshold: score it once per bar, at the
  // bar's adverse extreme and at its close (the two prices the replay offers).
  const advClose = t.side === "long" ? "low" : "high";
  const scores = [];
  for (let i = entryIdx; i < bars.length; i++) {
    const bar = bars[i];
    const realClose = bar.close;
    bar.close = bar[advClose];
    const adv = computeStockVector(bars, i, t.side, Number(t.entry_price));
    bar.close = realClose;
    const close = computeStockVector(bars, i, t.side, Number(t.entry_price));
    scores.push([
      adv ? Number(adv.combined_reversal_score) : null,
      close ? Number(close.combined_reversal_score) : null,
    ]);
  }

  prepared.push({ t, bars, spy, entryIdx, shares, scores, week: date <= "2026-11-06" ? "wk1" : "wk2" });
}

// --- one replay of every trade at one C setting ------------------------------
function replay({ stock, market, exit }) {
  PROTECTIVE_BY_SYSTEM.C.stockThreshold = stock;
  PROTECTIVE_BY_SYSTEM.C.marketThreshold = market;
  VECTOR_EXIT_BY_SYSTEM.C = exit;

  const totals = { total: 0 };
  const reasons = {};
  const per = {};
  const weeks = { wk1: 0, wk2: 0 };
  let closed = 0;

  for (const p of prepared) {
    const { t, bars, spy, entryIdx, shares, scores } = p;
    const sys = t.system;
    const pos = {
      symbol: t.symbol,
      side: t.side,
      status: "open",
      entry_time: t.entry_time,
      entry_price: Number(t.entry_price),
      shares,
      initial_shares: shares,
      tcb: shares * Number(t.entry_price),
      pressed_1r: false,
      pressed_2r: false,
      pressed_3r: false,
      presses: [],
      checked_loss_levels: [],
      vector_checkpoints: [],
      profit_checkpoints: [],
      profit_grid_active: false,
      peak_pl: 0,
      commission_fees: 0,
    };

    let net = null;
    const apply = (patch) => patch && Object.assign(pos, patch);

    for (let i = entryIdx; i < bars.length && net == null; i++) {
      const bar = bars[i];
      const prices = [t.side === "long" ? bar.low : bar.high, bar.close];
      const nowIso = new Date(bar.timestamp + 30000).toISOString();
      const marketScore = i < spy.scores.length ? spy.scores[i] : spy.scores[spy.scores.length - 1];

      for (let phase = 0; phase < 2 && net == null; phase++) {
        const price = prices[phase];
        if (!(price > 0)) continue;
        const vectorScore = scores[i - entryIdx][phase];

        if (!pos.protective_stop_active) {
          const arm = assessProtectiveTrigger({
            system: sys,
            position: pos,
            nowIso,
            candles: bars.slice(0, i + 1),
            marketCandles: spy.candles.slice(0, Math.min(i + 1, spy.candles.length)),
            stockScore: vectorScore,
            marketScore,
          });
          if (arm.action === "activate") apply(arm.patch);
        }

        const d = decideTick({ system: sys, position: pos, price, nowIso, vectorScore });
        (d.prior_patches || []).forEach(apply);
        apply(d.patch);

        if (d.action === "exit") {
          net = Number(d.net_pl) || 0;
          reasons[d.exit_reason] = (reasons[d.exit_reason] || 0) + 1;
        }
      }
    }

    if (net == null) {
      // Still open at the bell: the engine's own 16:00 close, on the last bar's close.
      const last = bars[bars.length - 1];
      const d = decideTick({
        system: sys,
        position: pos,
        price: last.close,
        nowIso: new Date(last.timestamp + 2700000).toISOString(),
      });
      net = d.action === "exit" ? Number(d.net_pl) || 0 : 0;
      reasons[d.exit_reason || "unclosed"] = (reasons[d.exit_reason || "unclosed"] || 0) + 1;
    }

    closed++;
    per[sys] = (per[sys] || 0) + net;
    if (sys === "C") {
      if (p.week === "wk2") weeks.wk2 += net;
      else weeks.wk1 += net;
    }
    totals.total += net;
  }

  return {
    stock,
    market,
    exit,
    trades: closed,
    net: Math.round(totals.total * 100) / 100,
    ...Object.fromEntries(Object.entries(per).map(([k, v]) => [k.toLowerCase(), Math.round(v * 100) / 100])),
    ...Object.fromEntries(Object.entries(weeks).map(([k, v]) => [k, Math.round(v * 100) / 100])),
    reasons,
  };
}

if (prepared.length === 0) {
  console.error("No trade could be prepared — check the data directory.");
  process.exit(1);
}

// --- the sweep ---------------------------------------------------------------
const STOCK = [25, 35, 45, 55, 65];
const MARKET = [65, 75, 85, 90, 95, 100];
const ARMING = [];
for (const s of STOCK) for (const m of MARKET) ARMING.push(replay({ stock: s, market: m, exit: 65 }));

const best = ARMING.reduce((a, b) => (b.c > a.c ? b : a));
const EXITS = [35, 40, 45, 50, 55, 65, 75].map((e) =>
  replay({ stock: best.stock, market: best.market, exit: e })
);
const bestExit = EXITS.reduce((a, b) => (b.c > a.c ? b : a));

// A finer grid around the winner, so a single lucky cell is not mistaken for an edge.
const REFINE = [];
for (const s of [35, 40, 45, 50]) for (const m of [80, 85]) for (const e of [42, 45, 48])
  REFINE.push(replay({ stock: s, market: m, exit: e }));

const out = {
  ranAt: new Date().toISOString(),
  trades: prepared.length,
  arming: ARMING,
  exitSweep: EXITS,
  refine: REFINE,
};
fs.writeFileSync(path.join(DATA, "results.json"), JSON.stringify(out, null, 1));

const line = (r) =>
  `stock ${String(r.stock ?? "-").padStart(3)}  market ${String(r.market ?? "-").padStart(3)}  exit ${String(r.exit ?? "-").padStart(3)}` +
  `   C ${String(Math.round(r.c)).padStart(8)}   wk1 ${String(Math.round(r.wk1)).padStart(7)}  wk2 ${String(Math.round(r.wk2)).padStart(7)}   total ${String(Math.round(r.net)).padStart(8)}`;
console.log(`trades replayed: ${prepared.length}`);
console.log("\nARMING SWEEP (exit held at 65)");
ARMING.forEach((r) => console.log(line(r)));
console.log("\nEXIT SWEEP (arming at the best pair above)");
EXITS.forEach((r) => console.log(line(r)));
console.log(`\nREFINE around ${best.stock}/${best.market}/${bestExit.exit} — C net by cell, then by week`);
REFINE.forEach((r) =>
  console.log(line(r) + `   wk1 ${String(Math.round(r.wk1)).padStart(7)}   wk2 ${String(Math.round(r.wk2)).padStart(7)}`)
);