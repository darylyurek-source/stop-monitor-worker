// engineShadow.js — SHADOW MODE: decide every tick on Render, write nothing.
//
// This is step 3 of the migration. For each tick the worker already forwards to
// Base44, it also runs the portable engine against the SAME price and the SAME
// position state, and records:
//
//   • the engine's verdict, and how long the decision itself took (microseconds);
//   • Base44's own verdict for the same tick, taken from the response;
//   • whether they agree, and — when an exit differs — the price difference.
//
// It never writes to a position table. positions_* are read once into the book and
// the only write here is a row in the ShadowTick entity, which no trading code
// reads. That is what makes the run safe to leave on for a whole session.
//
// WHAT THE COMPARISON PROVES, and what it does not: both engines are given the same
// price and the same book, so a disagreement here is a RULE disagreement, not a
// timing artefact — the one bucket that blocks cutover. Base44 acting a minute late
// shows up as Base44 reporting a hold where the engine reports an exit, and that is
// recorded as lag, not as an engine defect.

import { decideTick } from "./tickDecisionCore.js";
import { assessProtectiveTrigger } from "./protectiveTrigger.js";
import { autoArmPolicy } from "./tickRules.js";
import { applyTick, bars as candleBars, isSeeded, seed } from "./candleService.js";
import { get as getPosition } from "./positionBook.js";
import { pressSizing } from "./dBudget.js";
import { bulkUpsertEntities, bridgeConfigured } from "./bridge.js";

const FLUSH_MS = 5000;
const FLUSH_ROWS = 40;
const ACTIONS = new Set(["exit", "press", "partial", "grid", "hold", "needs_vector"]);

const state = {
  enabled: false,
  systems: new Set(),
  rows: [],
  written: 0,
  errors: 0,
  ticks: 0,
  decisions: 0,
  agree: 0,
  disagree: 0,
  unread: 0,
  decideMicros: [],
};

export function enabled() {
  return state.enabled;
}

export function enable(systems) {
  state.enabled = true;
  state.systems = new Set((systems || []).map((s) => String(s).toUpperCase()));
}

export function stats() {
  const d = state.decideMicros;
  const avg = d.length ? Math.round(d.reduce((a, b) => a + b, 0) / d.length) : null;
  const max = d.length ? Math.max(...d) : null;
  return {
    enabled: state.enabled,
    systems: [...state.systems],
    ticks: state.ticks,
    decisions: state.decisions,
    agree: state.agree,
    disagree: state.disagree,
    unreadable: state.unread,
    rows_written: state.written,
    errors: state.errors,
    decide_avg_us: avg,
    decide_max_us: max,
  };
}

// Seed the series for a symbol before the first decision that needs it. Called from
// the sync loop, never from the tick path, so no tick waits on a fetch.
export async function primeSymbols(symbols) {
  if (!state.enabled || !bridgeConfigured()) return;
  for (const symbol of symbols) {
    if (isSeeded(symbol)) continue;
    try {
      await seed(symbol);
    } catch (err) {
      console.error(`[shadow] seed ${symbol}: ${err?.message || err}`);
    }
  }
}

// Decide one tick. Returns the verdict, or null when shadow mode is off or the
// position is not in the book. Never throws, never writes.
export function decide(ref, symbol, price, nowMs = Date.now()) {
  if (!state.enabled || !state.systems.has(ref.system)) return null;
  const pos = getPosition(ref.system, ref.positionId);
  if (!pos) {
    state.unread += 1;
    return null;
  }
  state.ticks += 1;
  const series = applyTick(symbol, price, nowMs);
  const nowIso = new Date(nowMs).toISOString();

  // PROTECTIVE STOP — assessed first, on the same bars, exactly as the live manager
  // arms before the tick decides. Without this the engine can ENFORCE the $350
  // giveback but can never ARM it, so on an account Render owned the stop would
  // simply never fire (13 of 27 exits on 2026-10-30 were protective stops).
  // The patch travels on the verdict so the live writer persists it — merged into
  // the decision's own write when there is one, on its own when there is not.
  let effective = pos;
  let arming = null;
  if (!pos.protective_stop_active && Number(pos.shares) > 0) {
    try {
      arming = assessProtectiveTrigger({
        system: ref.system,
        position: pos,
        nowIso,
        price,
        candles: series && series.length ? series : null,
        marketCandles: candleBars("SPY"),
      });
    } catch (err) {
      console.error(`[shadow] arming ${ref.system} ${symbol}: ${err?.message || err}`);
    }
    if (arming && arming.action === "activate") effective = { ...pos, ...arming.patch };
  }

  // DART D's press size, measured against the day's buying power and the open book.
  // null for every other system, and null for D when no budget for today is known —
  // in which case the engine answers "needs_budget" rather than pressing an unknown
  // amount.
  const sizing = pressSizing(ref.system, nowMs);

  const started = process.hrtime.bigint();
  let verdict = null;
  try {
    verdict = decideTick({
      system: ref.system,
      position: effective,
      price,
      nowIso,
      candles: series && series.length ? series : undefined,
      pressSizeUsd: sizing ? sizing.pressSizeUsd : undefined,
      pressBudgetFree: sizing ? sizing.free : undefined,
    });
  } catch (err) {
    state.errors += 1;
    console.error(`[shadow] decide ${ref.system} ${symbol}: ${err?.message || err}`);
    return null;
  }
  const micros = Number(process.hrtime.bigint() - started) / 1000;
  state.decideMicros.push(Math.round(micros));
  if (state.decideMicros.length > 5000) state.decideMicros.shift();
  state.decisions += 1;

  // Carry the arming write on the verdict: first in prior_patches so a decision that
  // also writes lands both fields in one guarded update.
  if (verdict && arming && arming.action === "activate") {
    verdict.arming_patch = arming.patch;
    verdict.arming = {
      triggered_by: arming.triggered_by,
      stock_score: arming.stock_score,
      market_score: arming.market_score,
      reference_price: arming.reference_price,
    };
    verdict.prior_patches = [arming.patch, ...(verdict.prior_patches || [])];
  }

  // DART B's RULE FROM 2026-11-09 (before that Monday's open): the $350 giveback arms
  // AUTOMATICALLY the moment a position's P&L reaches +$2,000 — no Vector test. Below
  // +$2,000 the Vector test above is untouched, so the two paths are: auto-arm at
  // +$2,000, or the Vector test arming it earlier. The level moved here from DART C on
  // 2026-11-07, which makes C the control (Vector test only). B only; A, C, D and E
  // have no row here.
  const autoArmAt = autoArmPolicy(ref.system);
  if (
    verdict &&
    autoArmAt != null &&
    verdict.action !== "exit" &&
    !(arming && arming.action === "activate") &&
    !effective.protective_stop_active &&
    Number.isFinite(Number(verdict.pl_raw)) &&
    Number(verdict.pl_raw) >= autoArmAt
  ) {
    const autoPatch = {
      protective_stop_active: true,
      protective_high_water_pl: Math.round(Number(verdict.pl_raw) * 100) / 100,
      protective_triggered_time: nowIso,
    };
    verdict.arming_patch = autoPatch;
    verdict.arming = { triggered_by: `auto_arm_${autoArmAt}` };
    verdict.prior_patches = [autoPatch, ...(verdict.prior_patches || [])];
  }

  return verdict;
}

// Base44's verdict for the same tick, normalised to the engine's vocabulary.
function base44Action(body) {
  if (!body || typeof body !== "object") return { action: "no_response" };
  if (body.closed) return { action: "exit", event: body.exit_reason || "closed", pl: body.pl };
  if (body.applied) return { action: "write", event: body.event || "applied", pl: body.pl };
  if (body.already_closed) return { action: "skipped", event: "already_closed" };
  return { action: "hold", event: body.event || "hold", pl: body.pl };
}

// Record one tick: the engine's verdict beside Base44's, on the same price.
export function record(ref, symbol, price, verdict, body, nowMs = Date.now()) {
  if (!state.enabled || !state.systems.has(ref.system) || !verdict) return;
  if (!ACTIONS.has(verdict.action)) return; // skipped/halted/invalid carry no rule

  const theirs = base44Action(body);
  const engineActed = verdict.action !== "hold" && verdict.action !== "needs_vector";
  const base44Acted = theirs.action === "exit" || theirs.action === "write";

  // Agreement on the QUESTION, not on the wording: did both see nothing, or did
  // both see something? A needs_vector verdict is a data gap, never a difference.
  let agree = null;
  if (verdict.action === "needs_vector") agree = null;
  else if (engineActed && base44Acted) agree = true;
  else if (!engineActed && !base44Acted) agree = true;
  else agree = false;

  if (agree === true) state.agree += 1;
  else if (agree === false) state.disagree += 1;

  const iso = new Date(nowMs).toISOString();
  state.rows.push({
    id: `tick|${ref.system}|${ref.positionId}|${iso}`,
    shadow_key: `tick|${ref.system}|${ref.positionId}|${iso}`,
    kind: "tick",
    system: ref.system,
    position_id: ref.positionId,
    symbol,
    side: getPosition(ref.system, ref.positionId)?.side || null,
    observed_at: iso,
    price: Number(price),
    engine: {
      action: verdict.action,
      event: verdict.event || null,
      pl: verdict.pl_raw != null ? Number(verdict.pl_raw) : null,
      exit_reason: verdict.exit_reason || null,
      exit_price: verdict.exit_price != null ? Number(verdict.exit_price) : null,
      share_price: verdict.price != null ? Number(verdict.price) : null,
      vector_source: verdict.vector_source || null,
      vector_score: verdict.vector_score != null ? Number(verdict.vector_score) : null,
      pending_step: verdict.pending_step || null,
    },
    base44: {
      action: theirs.action,
      event: theirs.event || null,
      pl: theirs.pl != null ? Number(theirs.pl) : null,
      exit_reason: body?.exit_reason || null,
      exit_price: body?.exit_price != null ? Number(body.exit_price) : null,
    },
    agree,
    lag_ms: null,
    note: agree === false ? "rule disagreement on identical inputs" : null,
  });

  if (state.rows.length >= FLUSH_ROWS) flush();
}

export async function flush() {
  if (!state.rows.length || !bridgeConfigured()) return state.written;
  const batch = state.rows.splice(0, state.rows.length);
  const now = new Date().toISOString();
  try {
    await bulkUpsertEntities("ShadowTick", batch.map((r) => ({ created_date: now, updated_date: now, ...r })));
    state.written += batch.length;
  } catch (err) {
    state.errors += 1;
    console.error(`[shadow] flush ${batch.length} rows: ${err?.message || err}`);
  }
  return state.written;
}

export function startFlusher() {
  if (!bridgeConfigured()) return;
  setInterval(() => {
    flush().catch(() => {});
  }, FLUSH_MS).unref?.();
}