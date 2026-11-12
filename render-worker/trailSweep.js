// trailSweep.js — READ-ONLY trailing-stop width study, on the engine's own rule code.
//
//   node trailSweep.js
//
// WHAT IT ANSWERS. Every recorded trade from 2026-11-02 to 2026-11-11, on DART A
// (ANEW), B, C and D, replayed twice: once with the engine exactly as it is (the
// trailing stop starting at 1.75%), once with it starting at 1.25%. NOTHING ELSE
// MOVES in either run — the +$1,500, +$2,000, +$2,500 and +$3,500 rungs of the same
// ladder keep their own tighter percentages (1.00%, 0.75%, 0.50%, 0.35%), and every
// press, the $2,000 auto-arm, the protective stop, the profit sale, the hard stop,
// the Vector exits and the 4:00 PM close are the engine's own code.
//
// C is replayed on its OWN live Vector settings (arming 45/85, Vector Exit 45) and,
// as a reference only, on the retired 55/65/65 pair, so the trail effect can be read
// apart from the Vector change.
//
// HOW THE TRAIL WIDTH IS MOVED WITHOUT TOUCHING A RULE. tickDecisionCore derives the
// trailing percentage from cProfitTrailPct(peak P&L): the ladder's rungs for peaks of
// +$900 and up, and below +$900 the module fallback PRICE_TRAIL_PCT (1.75%). The
// study appends ONE lowest rung to that exported ladder (a peak of -Infinity, i.e.
// every peak below the first real rung) and sets it, together with the +$900 rung, to
// the width being tested. That is this process only: no file on disk changes, the
// worker's own default stays 1.75%, and the run restores 1.75% before it exits.
//
// The replay itself is replayDay.replayAccount — the day replay's own walk (bar by
// bar, each bar offered at its adverse extreme then its close, the protective stop
// assessed first, the auto-arm after), so the numbers are the same method the day
// replay uses, applied to every recorded record including replacements.
//
// IT WRITES NOTHING: no position, no order, no entity. Its output is a table on
// stdout and one JSON block, both readable in the job's log.

import fs from "node:fs";
import {
  PROTECTIVE_BY_SYSTEM,
  VECTOR_EXIT_BY_SYSTEM,
  C_PROFIT_TRAIL_TIERS,
} from "./tickRules.js";
import { ACCOUNTS, resolveConfig, loadOpenings, loadBars, replayAccount, etMs } from "./replayDay.js";
import { bridgeConfigured } from "./bridge.js";

const DATES = [
  "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06",
  "2026-11-09", "2026-11-10", "2026-11-11",
];
const WEEK = (d) => (d <= "2026-11-06" ? "wk1" : "wk2");
const WEEK_LABEL = { wk1: "Nov 2-6", wk2: "Nov 9-11" };

// --- the trail width --------------------------------------------------------

// The ladder as it stands, plus one rung that catches every peak below the lowest
// real one. Moving these two numbers is the whole study.
const BASE_TIER = { min_peak_pl: -Infinity, pct: 0.0175 };
C_PROFIT_TRAIL_TIERS.push(BASE_TIER);
const LOW_TIER = C_PROFIT_TRAIL_TIERS.find((t) => t.min_peak_pl === 900);

function setTrailPct(pct) {
  BASE_TIER.pct = pct;
  LOW_TIER.pct = pct;
}

// --- the runs ---------------------------------------------------------------

const TRAILS = [
  { key: "current", pct: 0.0175 },
  { key: "t125", pct: 0.0125 },
];

// C's live Vector pair, and the retired one it replaced (reference only).
const C_LIVE = { stock: 45, market: 85, exit: 45 };
const C_RETIRED = { stock: 55, market: 65, exit: 65 };

const RUNS = [];
for (const key of ["A", "B", "C", "D"]) {
  for (const t of TRAILS) {
    RUNS.push({
      id: `${key}|${t.key}`,
      account: key,
      system: ACCOUNTS[key].system,
      label: ACCOUNTS[key].label,
      trailKey: t.key,
      trail: t.pct,
      vector: key === "C" ? C_LIVE : null,
    });
  }
}
for (const t of TRAILS) {
  RUNS.push({
    id: `C|retired|${t.key}`,
    account: "C",
    system: "C",
    label: "DART C (55/65/65 ref)",
    trailKey: t.key,
    trail: t.pct,
    vector: C_RETIRED,
    reference: true,
  });
}

function applyRun(run) {
  setTrailPct(run.trail);
  const v = run.vector;
  PROTECTIVE_BY_SYSTEM.C.stockThreshold = v ? v.stock : 45;
  PROTECTIVE_BY_SYSTEM.C.marketThreshold = v ? v.market : 85;
  VECTOR_EXIT_BY_SYSTEM.C = v ? v.exit : 45;
}

// --- helpers ----------------------------------------------------------------

async function mapLimit(items, limit, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
}

const blank = () => ({
  trades: 0,
  net: 0,
  trail: 0,
  trailFollow: 0,
  followSum: 0,
  measured: 0,
  beyondSum: 0,
  other: 0,
});

function exitMsOf(date, label) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(label || ""));
  if (!m) return null;
  return etMs(date, Number(m[1]), Number(m[2]));
}

// Did the stock finish the session beyond the exit price, in the trade's direction?
function followThrough(bars, side, exitPx, exitMs, closeMs) {
  if (!(exitPx > 0) || exitMs == null) return null;
  let lastClose = null;
  for (const b of bars || []) {
    if (b.t < exitMs || b.t > closeMs) continue;
    if (Number(b.close) > 0) lastClose = Number(b.close);
  }
  if (lastClose == null) return null;
  const beyond = side === "long" ? lastClose - exitPx : exitPx - lastClose;
  return { beyond: Math.round(beyond * 100) / 100 };
}

// --- main -------------------------------------------------------------------

async function main() {
  const started = Date.now();
  await resolveConfig();
  if (!bridgeConfigured()) {
    console.error("[trail] no bridge credentials — cannot read the recorded trades");
    process.exit(1);
  }

  const stats = new Map(); // runId -> { wk1, wk2 }
  for (const run of RUNS) stats.set(run.id, { wk1: blank(), wk2: blank() });

  const coverage = {};
  const perDate = [];

  for (const date of DATES) {
    const openMs = etMs(date, 9, 30);
    const closeMs = etMs(date, 16, 0);

    // Every recorded record for the day, each account, replacements included.
    const rows = {};
    for (const key of ["A", "B", "C", "D"]) {
      rows[key] = await loadOpenings(ACCOUNTS[key].table, date, ACCOUNTS[key].system, {
        originalsOnly: false,
        limit: 2000,
      });
    }

    const symbols = new Set(["SPY"]);
    for (const key of Object.keys(rows)) for (const p of rows[key]) symbols.add(p.symbol);

    const barsBySymbol = new Map();
    await mapLimit([...symbols], 8, async (sym) => {
      barsBySymbol.set(sym, await loadBars(sym, date));
    });

    const missing = [...barsBySymbol].filter(([, b]) => !b.length).map(([s]) => s);
    coverage[date] = {
      symbols: symbols.size,
      missing: missing.length,
      missingSample: missing.slice(0, 8),
    };

    const records = Object.values(rows).reduce((a, r) => a + r.length, 0);
    for (const run of RUNS) {
      const openings = rows[run.account] || [];
      if (!openings.length) continue;
      applyRun(run);
      const result = replayAccount(
        { system: run.system, date, openings: structuredClone(openings) },
        barsBySymbol,
        openMs,
        closeMs
      );

      const bucket = stats.get(run.id)[WEEK(date)];
      for (const t of result.trades) {
        bucket.trades++;
        bucket.net += Number(t.net_pl || 0);
        if (t.exit !== "price_trail_stop") {
          bucket.other++;
          continue;
        }
        bucket.trail++;
        const ft = followThrough(
          barsBySymbol.get(String(t.symbol).toUpperCase()) || [],
          t.side,
          Number(t.exit_px),
          exitMsOf(date, t.exit_at),
          closeMs
        );
        if (!ft) continue;
        bucket.measured++;
        bucket.beyondSum += ft.beyond;
        if (ft.beyond > 0) {
          bucket.trailFollow++;
          bucket.followSum += ft.beyond;
        }
      }
    }
    perDate.push({ date, records, symbols: symbols.size, missing: missing.length });
  }

  // Restore the engine's own width before exiting — this process must leave nothing
  // behind, even though it is about to die.
  setTrailPct(0.0175);
  PROTECTIVE_BY_SYSTEM.C.stockThreshold = C_LIVE.stock;
  PROTECTIVE_BY_SYSTEM.C.marketThreshold = C_LIVE.market;
  VECTOR_EXIT_BY_SYSTEM.C = C_LIVE.exit;

  // --- report ---------------------------------------------------------------
  const money = (n) => `${n < 0 ? "-" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;
  const rowsOut = [];

  for (const run of RUNS) {
    const s = stats.get(run.id);
    const all = blank();
    for (const w of ["wk1", "wk2"]) {
      const b = s[w];
      for (const k of Object.keys(all)) all[k] += b[k];
    }
    const line = (weekKey, b) => ({
      account: run.account,
      label: run.label,
      reference: !!run.reference,
      trail: run.trail,
      trail_key: run.trailKey,
      vector: run.vector,
      week: weekKey,
      week_label: weekKey === "all" ? "Nov 2-11" : WEEK_LABEL[weekKey],
      trades: b.trades,
      net: Math.round(b.net * 100) / 100,
      trail_exits: b.trail,
      trail_then_favourable: b.trailFollow,
      trail_then_favourable_pct: b.trail ? Math.round((b.trailFollow / b.trail) * 1000) / 10 : null,
      avg_beyond_per_share: b.trailFollow ? Math.round((b.followSum / b.trailFollow) * 100) / 100 : null,
      measured_trail_exits: b.measured,
    });
    rowsOut.push(line("wk1", s.wk1), line("wk2", s.wk2), line("all", all));

    for (const wk of ["wk1", "wk2", "all"]) {
      const b = wk === "all" ? all : s[wk];
      const tag = `${run.label.padEnd(22)} ${(run.trail * 100).toFixed(2)}%  ${(wk === "all" ? "Nov 2-11" : WEEK_LABEL[wk]).padEnd(9)}`;
      console.log(
        `[trail] ${tag}  trades ${String(b.trades).padStart(4)}  net ${String(money(b.net)).padStart(11)}` +
          `  trail exits ${String(b.trail).padStart(4)}` +
          `  finished our way ${String(b.trailFollow).padStart(4)}` +
          ` (${b.trail ? ((b.trailFollow / b.trail) * 100).toFixed(1) : "0.0"}%)` +
          `  avg beyond ${b.trailFollow ? (b.followSum / b.trailFollow).toFixed(2) : "-"}/sh`
      );
    }
  }

  const payload = {
    ran_at: new Date().toISOString(),
    worker_commit: process.env.RENDER_GIT_COMMIT || null,
    dates: DATES,
    weeks: WEEK_LABEL,
    trail_tiers: C_PROFIT_TRAIL_TIERS.map((t) => ({ min_peak_pl: t.min_peak_pl, pct: t.pct })),
    coverage,
    per_date: perDate,
    rows: rowsOut,
    elapsed_ms: Date.now() - started,
  };
  const outFile = process.env.TRAIL_SWEEP_OUT || "/tmp/trail-sweep.json";
  try {
    fs.writeFileSync(outFile, JSON.stringify(payload, null, 1));
  } catch (_) {
    // a read-only filesystem is fine: stdout carries the same numbers
  }

  console.log("=== TRAIL SWEEP RESULT ===");
  console.log(JSON.stringify({ coverage, rows: rowsOut, worker_commit: payload.worker_commit }, null, 1));
  console.log("=== END TRAIL SWEEP RESULT ===");
}

main().catch((err) => {
  console.error(`[trail] failed: ${err?.stack || err}`);
  process.exit(1);
});