// replayDay.js — THE DAY REPLAY, RUN BY THE ENGINE'S OWN RULE CODE.
//
// WHY THIS FILE EXISTS. The replay tool that lived on Base44 could never use the rule
// code that trades: a backend function cannot bundle render-worker/, so it ran a
// RE-IMPLEMENTATION (base44/shared/simDartCore.ts). That copy fell behind the engine —
// by 2026-11-10 the engine carried B's 25% profit-protection sale at +$1,850 and the
// +$2,000 auto-arm on A, B, C and D, none of which the copy knew about — so a "nothing
// changed" answer from that replay could not be trusted. This file removes the copy:
// the replay is replayed by tickDecisionCore.js, protectiveTrigger.js, tickRules.js and
// vectorCore.js, the same modules a live tick runs through.
//
// WHAT IT DOES. One recorded trading day, three accounts (A = ANEW, B, C):
//   • the day's recorded positions are read from Cloud SQL (positions_anew/_b/_c,
//     chain_index 0 originals) and seeded at their OPENING state (initial_shares, cost
//     basis, entry fees) — a recorded row holds the position's end-of-day shape, so
//     seeding that shape would start the replay at the wrong size;
//   • the session's 1-minute bars are walked in ET time order from 9:30 to 16:00, the
//     stock series and SPY built progressively so no decision can see a bar that had not
//     happened yet;
//   • each bar is offered twice per position: first at its ADVERSE extreme (the low for
//     a long, the high for a short — the intrabar risk a 1-minute series cannot order),
//     then at its close;
//   • every decision is decideTick(), with the protective-stop arming assessed first by
//     assessProtectiveTrigger() and the +$2,000 auto-arm applied after, in the same order
//     the live tick path uses (engineShadow.decide);
//   • the verdict's patches are merged into an IN-MEMORY copy of the position exactly as
//     positionBook.apply merges them for a live write.
//
// NOTHING IS WRITTEN to a position table. The replay opens no socket, subscribes to no
// feed and calls no Base44 tick handler. Its only write is one RenderReplay row per
// account, which no trading code reads.
//
// DOCUMENTED LIMITS (returned with every run):
//   1. 1-minute bars: inside a minute the order of events cannot be known, so the replay
//      offers the adverse extreme and the close rather than every tick. Absolute values
//      differ from the recorded marks; two runs of THIS method are directly comparable.
//   2. The trade set is the day's recorded positions — a rule change that would have
//      opened, skipped or replaced a position does not change this day's trade count.
//   3. Replacements are not re-selected: the replay closes what the account traded.
//
// USAGE. From the Render service's Shell (or any container built from this repo):
//     node replayDay.js 2026-11-06
// Options:
//     --systems=A,B,C   which accounts (default all three)
//     --no-write        print only; do not write the RenderReplay rows
//     --verbose         also print every trade line
// ============================================================================

import fetch from "node-fetch";
import { configure as configureCandles, providerBars } from "./candleService.js";
import { bridge, bridgeConfigured, configure as configureBridgeCreds, listCandles } from "./bridge.js";
import { decideTick } from "./tickDecisionCore.js";
import { assessProtectiveTrigger } from "./protectiveTrigger.js";
import { autoArmPolicy, orderCost, slippageCost, r2 } from "./tickRules.js";

const BASE44_APP_URL = (process.env.BASE44_APP_URL || "").replace(/\/$/, "");
const BASE44_API_KEY = process.env.BASE44_API_KEY;

// The accounts the replay covers, and where their records live. A is the New DART A
// (ANEW); B is the standard and the opener; C is B's rule set.
const ACCOUNTS = {
  A: { system: "ANEW", table: "positions_anew", label: "DART A" },
  B: { system: "B", table: "positions_b", label: "DART B" },
  C: { system: "C", table: "positions_c", label: "DART C" },
};

const RULE_SOURCE = "the Render engine's own modules in this repository — tickDecisionCore.decideTick + protectiveTrigger.assessProtectiveTrigger + tickRules (costs, thresholds, auto-arm) + vectorCore, the exact code a live tick runs through";

// --- ET clock helpers --------------------------------------------------------

const ET_FMT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});

// Called as a function so the formatter's own `this` stays bound: taking
// formatToParts off the instance and calling it bare throws on every use.
function etParts(date) {
  return ET_FMT.formatToParts(date);
}

// The UTC instant of an ET wall-clock time on a date (handles EST/EDT).
function etMs(date, hh, mm) {
  const want = Date.parse(`${date}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00Z`);
  let guess = want;
  for (let i = 0; i < 2; i++) {
    const parts = etParts(new Date(guess));
    const g = (t) => Number((parts.find((p) => p.type === t) || {}).value);
    const asIfUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"));
    guess += want - asIfUtc;
  }
  return guess;
}

// HH:MM ET for an instant, so every line reads in the session's own clock.
function etLabel(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return null;
  const parts = etParts(new Date(n));
  const g = (t) => (parts.find((p) => p.type === t) || {}).value;
  return `${g("hour")}:${g("minute")}`;
}

// --- config (same resolution order as worker.js) -----------------------------

async function resolveConfig() {
  let bridgeUrl = (process.env.BRIDGE_URL || "").replace(/\/$/, "");
  let bridgeKey = process.env.BRIDGE_API_KEY;
  let massiveKey = String(process.env.MASSIVE_API_KEY || "").trim();

  if ((!bridgeUrl || !bridgeKey || !massiveKey) && BASE44_APP_URL && BASE44_API_KEY) {
    try {
      const res = await fetch(`${BASE44_APP_URL}/functions/getWorkerBridgeConfig`, {
        method: "POST",
        headers: { Authorization: `Bearer ${BASE44_API_KEY}`, "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(15000),
      });
      const body = await res.json().catch(() => null);
      bridgeUrl = bridgeUrl || String(body?.bridge_url || "").replace(/\/$/, "");
      bridgeKey = bridgeKey || String(body?.bridge_api_key || "");
      massiveKey = massiveKey || String(body?.massive_api_key || "").trim();
    } catch (err) {
      console.error(`[config] Base44 did not return bridge credentials (${err?.message || err})`);
    }
  }

  configureBridgeCreds(bridgeUrl, bridgeKey);
  configureCandles(massiveKey);

  return { bridgeUrl, bridgeKey, massiveKey };
}

// --- inputs ------------------------------------------------------------------

// The day's recorded ORIGINAL positions for one account, seeded at opening state.
async function loadOpenings(table, date, system) {
  const rows = await bridge("filterPositionsInTable", {
    table,
    query: { test_date: date },
    sort: "entry_time",
    limit: 500,
  });

  return (Array.isArray(rows) ? rows : [])
    // ORIGINALS ONLY — chain_index 0, and a record that carries no chain index at all
    // is one (the app resolves a missing index as 0, so the two agree).
    .filter((row) => Number(row?.chain_index || 0) === 0)
    .map((row) => {
      const entryPrice = Number(row.entry_price);
      const opened = Number(row.initial_shares) > 0 ? Number(row.initial_shares) : Number(row.shares);
      if (!row.symbol || !Number.isFinite(entryPrice) || !(opened > 0)) return null;

      const shares = Math.floor(opened);
      const tcb = r2(shares * entryPrice);
      // Entry fees, charged with the engine's own cost model — the same figure the live
      // opener puts on a new position, so `net_pl` at the exit covers the whole trade.
      const entryFees = r2(orderCost(shares, entryPrice, false) + slippageCost(shares, entryPrice));

      return {
        id: String(row.id),
        system,
        symbol: String(row.symbol).toUpperCase(),
        exchange: row.exchange || null,
        side: row.side,
        status: "open",
        entry_time: row.entry_time,
        entry_price: entryPrice,
        shares,
        initial_shares: shares,
        tcb,
        dollar_value: r2(shares * entryPrice),
        pressed_1r: false, pressed_2r: false, pressed_3r: false,
        presses: [],
        current_price: entryPrice,
        current_pl: 0,
        peak_pl: 0,
        commission_fees: entryFees,
        checked_loss_levels: [],
        vector_checkpoints: [],
        profit_grid_active: false,
        profit_checkpoints: [],
        partial_profit_taken: false,
        partial_exits: [],
        realized_partial_gross: 0,
        protective_stop_active: false,
        protective_high_water_pl: null,
        price_trail_active: false,
        price_trail_extreme: null,
        _opened: Date.parse(row.entry_time),
      };
    })
    .filter(Boolean);
}

// The session's 1-minute bars for one symbol: the provider's own aggregates first (a
// full session with real volume, exactly what candleService seeds a live series from),
// the recorded archive second.
async function loadBars(symbol, date) {
  let bars = await providerBars(symbol, date).catch(() => []);
  if (!bars.length) {
    const rows = await listCandles(symbol, date).catch(() => []);
    bars = (Array.isArray(rows) ? rows : [])
      .map((row) => {
        const t = Number(row.candle_epoch) || Date.parse(row.candle_time);
        const close = Number(row.close);
        if (!Number.isFinite(t) || !Number.isFinite(close) || close <= 0) return null;
        return {
          t: Math.floor(t / 60000) * 60000,
          open: Number(row.open) || close,
          high: Number(row.high) || close,
          low: Number(row.low) || close,
          close,
          volume: Number(row.volume) || 0,
        };
      })
      .filter(Boolean);
  }
  return bars
    .filter((b) => Number(b.close) > 0)
    .sort((a, b) => a.t - b.t);
}

// --- one account -------------------------------------------------------------

function replayAccount(account, barsBySymbol, openMs, closeMs) {
  const system = account.system;
  const positions = account.openings.slice();
  const series = new Map();   // symbol -> progressive bars
  const trades = [];
  let fired = new Set();

  const symbols = [...new Set(positions.map((p) => p.symbol).concat(["SPY"]))];
  const bars = symbols.flatMap((sym) =>
    (barsBySymbol.get(sym) || []).map((bar) => ({ sym, bar }))
  ).sort((a, b) => a.bar.t - b.bar.t);

  const spySeries = () => series.get("SPY") || null;

  // One decision point for one position at one price.
  function decideAt(pos, price, atMs) {
    if (!(price > 0) || pos.status === "closed") return;
    if (atMs < pos._opened) return;

    const nowIso = new Date(atMs).toISOString();
    const candles = series.get(pos.symbol) || null;

    // PROTECTIVE ARMING FIRST — the same order engineShadow.decide uses.
    let effective = pos;
    let arming = null;
    if (!pos.protective_stop_active && Number(pos.shares) > 0) {
      try {
        arming = assessProtectiveTrigger({
          system,
          position: pos,
          nowIso,
          price,
          candles: candles && candles.length ? candles : null,
          marketCandles: spySeries(),
        });
      } catch (err) {
        console.error(`[replay] arming ${system} ${pos.symbol}: ${err?.message || err}`);
      }
      if (arming?.action === "activate") effective = { ...pos, ...arming.patch };
    }

    let verdict = null;
    try {
      verdict = decideTick({ system, position: effective, price, nowIso, candles: candles || undefined });
    } catch (err) {
      console.error(`[replay] decide ${system} ${pos.symbol}: ${err?.message || err}`);
      return;
    }
    if (!verdict || verdict.skipped) return;

    // Patches merge in the live writer's order: the arming write, then the decision's
    // prior patches, then its own patch.
    if (arming?.action === "activate") Object.assign(pos, arming.patch);
    for (const patch of verdict.prior_patches || []) Object.assign(pos, patch);
    if (verdict.patch) Object.assign(pos, verdict.patch);

    // THE +$2,000 AUTO-ARM, applied after the decision exactly as engineShadow does.
    const autoArmAt = autoArmPolicy(system);
    if (
      autoArmAt != null &&
      verdict.action !== "exit" &&
      arming?.action !== "activate" &&
      !pos.protective_stop_active &&
      Number.isFinite(Number(verdict.pl_raw)) &&
      Number(verdict.pl_raw) >= autoArmAt
    ) {
      Object.assign(pos, {
        protective_stop_active: true,
        protective_high_water_pl: r2(Number(verdict.pl_raw)),
        protective_triggered_time: nowIso,
      });
      fired.add("auto_arm_2000");
    }

    if (verdict.action === "press") fired.add(verdict.event || "press");
    else if (verdict.action === "partial") fired.add("partial_profit_exit");
    else if (verdict.action === "grid") fired.add("vector_profit_grid");
    else if (verdict.action === "exit") {
      fired.add(verdict.exit_reason || "exit");
      trades.push({
        id: pos.id,
        symbol: pos.symbol,
        side: pos.side,
        entry: etLabel(pos._opened),
        entry_px: r2(pos.entry_price),
        presses: (pos.presses || []).map((x) => `${x.level} ${etLabel(Date.parse(x.timestamp))} @${r2(x.price_added)} +${x.shares_added}`),
        partials: (pos.partial_exits || []).map((x) => `${etLabel(Date.parse(x.timestamp))} ${x.shares}sh @${r2(x.price)} net ${r2(x.net_pl)}`),
        exit: verdict.exit_reason,
        exit_at: etLabel(atMs),
        exit_px: r2(pos.exit_price),
        gross_pl: r2(pos.gross_pl),
        commission_fees: r2(pos.commission_fees),
        net_pl: r2(pos.net_pl),
        peak_pl: r2(pos.peak_pl),
        protective_armed: pos.protective_triggered_time || null,
        status: "closed",
      });
    }
  }

  // Walk the session in ET time order. Each bar grows that symbol's series, then is
  // offered to every open position in that symbol — adverse extreme first, close second.
  for (const { sym, bar } of bars) {
    if (bar.t < openMs || bar.t > closeMs) continue;
    if (!series.has(sym)) series.set(sym, []);
    series.get(sym).push(bar);

    for (const pos of positions) {
      if (pos.symbol !== sym) continue;
      const adverse = pos.side === "long" ? Number(bar.low) : Number(bar.high);
      decideAt(pos, adverse > 0 ? adverse : Number(bar.close), bar.t);
      decideAt(pos, Number(bar.close), bar.t);
    }
  }

  // The 16:00 ET session end: a position with no print after 15:59 still has to close,
  // and decideTick's own close_1600 rule does it on the last price the tape carried.
  const closeAt = etMs(account.date, 16, 0);
  for (const pos of positions) {
    if (pos.status === "closed") continue;
    const lastPrice = Number(pos.current_price) || Number(pos.entry_price);
    decideAt(pos, lastPrice, closeAt);
  }

  const closed = trades;
  const stillOpen = positions.filter((p) => p.status !== "closed");

  return {
    trades,
    stillOpen,
    fired: [...fired],
    dayNet: r2(closed.reduce((a, t) => a + Number(t.net_pl || 0), 0)),
    dayGross: r2(closed.reduce((a, t) => a + Number(t.gross_pl || 0), 0)),
    dayCommission: r2(closed.reduce((a, t) => a + Number(t.commission_fees || 0), 0)),
  };
}

// --- main --------------------------------------------------------------------

function parseArgs(argv) {
  const out = { date: null, systems: ["A", "B", "C"], write: true, verbose: false };
  for (const arg of argv) {
    if (arg.startsWith("--systems=")) {
      out.systems = arg.slice("--systems=".length).split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    } else if (arg === "--no-write") out.write = false;
    else if (arg === "--verbose") out.verbose = true;
    else if (!arg.startsWith("--")) out.date = arg;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const date = args.date || new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const started = Date.now();

  const cfg = await resolveConfig();
  if (!bridgeConfigured()) {
    console.error("[replay] no bridge credentials — cannot read the day's records");
    process.exit(1);
  }
  if (!cfg.massiveKey) console.warn("[replay] no market-data key — falling back to the recorded archive for bars");

  const openMs = etMs(date, 9, 30);
  const closeMs = etMs(date, 16, 0);

  const out = {};
  for (const key of args.systems) {
    const account = ACCOUNTS[key];
    if (!account) continue;
    account.date = date;
    account.openings = await loadOpenings(account.table, date, account.system);

    const symbols = [...new Set(account.openings.map((p) => p.symbol).concat(["SPY"]))];
    const barsBySymbol = new Map();
    for (const sym of symbols) barsBySymbol.set(sym, await loadBars(sym, date));

    const started2 = Date.now();
    const result = replayAccount(account, barsBySymbol, openMs, closeMs);

    out[key] = {
      label: account.label,
      system: account.system,
      trade_date: date,
      rule_source: RULE_SOURCE,
      positions: account.openings.length,
      closed: result.trades.length,
      open_at_close: result.stillOpen.length,
      day_net_pl: result.dayNet,
      day_gross_pl: result.dayGross,
      day_commissions: result.dayCommission,
      fired: result.fired,
      signature: result.trades.map(
        (t) =>
          `${t.symbol} ${t.side} ${t.entry}@${t.entry_px} [${t.presses.join("; ")}] -> ${t.exit} ${t.exit_at}@${t.exit_px} net ${t.net_pl}`
      ),
      trades: result.trades,
      bars: Object.fromEntries([...barsBySymbol].map(([s, b]) => [s, b.length])),
      elapsed_ms: Date.now() - started2,
    };
    console.log(`[replay] ${account.label} ${date}: ${result.trades.length} closed, net ${result.dayNet}`);
    if (args.verbose) for (const line of out[key].signature) console.log(`[replay]   ${line}`);
  }

  const payload = {
    trade_date: date,
    rule_source: RULE_SOURCE,
    method:
      "the day's recorded positions replayed through the engine's own decideTick/assessProtectiveTrigger, one decision at each 1-minute bar's adverse extreme and close, replacements not re-selected",
    limits: [
      "1-minute bars: intrabar event order unknown, so each bar is offered at its adverse extreme and its close. Absolute values differ from the recorded marks; two runs of this method are directly comparable.",
      "The trade set is the day's recorded positions, so a rule change that would have opened, skipped or replaced a position does not change this day's trade count.",
    ],
    systems: out,
    worker_commit: process.env.RENDER_GIT_COMMIT || null,
    elapsed_ms: Date.now() - started,
  };

  if (args.write) {
    const rowNow = new Date().toISOString();
    const rows = Object.entries(out).map(([key, v]) => ({
      id: `render_replay|${key}|${date}`,
      created_date: rowNow,
      updated_date: rowNow,
      run_key: `render_replay|${key}|${date}`,
      trade_date: date,
      system: key,
      label: v.label,
      day_net_pl: v.day_net_pl,
      day_gross_pl: v.day_gross_pl,
      day_commissions: v.day_commissions,
      positions: v.positions,
      closed: v.closed,
      open_at_close: v.open_at_close,
      fired: v.fired,
      signature: v.signature,
      rule_source: RULE_SOURCE,
      method: payload.method,
      worker_commit: payload.worker_commit,
      ran_at: new Date().toISOString(),
      elapsed_ms: v.elapsed_ms,
    }));
    try {
      const res = await bridge("bulkUpsertEntities", { entity_name: "RenderReplay", records: rows });
      console.log(`[replay] wrote ${rows.length} RenderReplay row(s): ${JSON.stringify(res)}`);
    } catch (err) {
      console.error(`[replay] could not write RenderReplay rows: ${err?.message || err}`);
    }
  }

  console.log("=== RENDER REPLAY RESULT ===");
  console.log(JSON.stringify(payload, null, 2));
  console.log("=== END RENDER REPLAY RESULT ===");
}

main().catch((err) => {
  console.error(`[replay] failed: ${err?.stack || err}`);
  process.exit(1);
});