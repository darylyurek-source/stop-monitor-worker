// priceIncidents.js — PERMANENT MONITORING HISTORY for the price-integrity gate.
//
// Every price the gate (tradeConditions.admitPrice) REFUSES or QUARANTINES is written
// to PostgreSQL, with the symbol, the time it was received, the provider's own stamp
// for the print, the price, the verdict and the reason code and text, the source door
// it arrived on, and which DART accounts (A / B / C / D) held that symbol at that
// moment. A record of an accepted price is not an incident, so only the two integrity
// verdicts are stored.
//
// WHAT THIS MODULE IS NOT. It decides nothing. It takes the verdict the gate has
// already reached, copies it into a row and appends that row to an in-memory buffer.
// It never touches a price, a threshold, a position, an order, a stop or an exit, and
// it never awaits anything on the tick path — a bridge round trip on the tick would be
// exactly the latency the Render engine exists to remove.
//
// WHY IT SURVIVES A RESTART. The buffer is only a staging area; every batch lands in
// the `entity_store` table in Cloud SQL through the same whitelisted bridge operation
// the shadow-run rows use (bulkUpsertEntities, keyed on `id`). Nothing is kept in a
// file or in this process's memory once flushed, so a Render redeploy, crash or
// restart cannot erase history. SIGTERM flushes whatever is still buffered.
//
// COST ON THE TRADING PATH, measured by construction:
//   • record()  — one object build and one array push: no I/O, no await, no JSON.
//   • flush()   — one HTTP call per 500 rows, every 5 s, off the tick path entirely.
//   • buffer cap — 20 000 rows. If the bridge is unreachable while a burst arrives, the
//     oldest rows are dropped and COUNTED (`dropped` in stats), so a database outage can
//     never grow this process's memory without limit and can never slow a tick down.

import { bulkUpsertEntities, bridgeConfigured } from "./bridge.js";

export const ENTITY = "PriceRejection";

const FLUSH_MS = 5000;          // staging window
const FLUSH_ROWS = 500;         // rows per bridge call
const MAX_BATCHES_PER_FLUSH = 4; // 2 000 rows per 5 s, and never a tight loop
const MAX_BUFFER = 20000;       // hard memory ceiling

// Which process wrote a row. A restart produces a new run id, so the history shows
// exactly which deploy a refusal came from.
const RUN_STARTED_AT = new Date().toISOString();
const RUN_ID = `${RUN_STARTED_AT}#${process.pid}`;

// One cached formatter: a trading day is read in ET, and building an Intl formatter per
// row would be the only non-trivial cost this module adds.
const ET_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const state = {
  buffer: [],
  recorded: 0,
  written: 0,
  dropped: 0,
  errors: 0,
  flushing: false,
  last_flush_at: null,
  last_error: null,
};

// symbol -> the accounts holding it. Supplied by the worker (it owns the routing map),
// so this module has no dependency on it and cannot import a cycle.
let systemsFor = () => [];

let seq = 0;
let timer = null;

// Called once at startup, after the bridge credentials are resolved.
export function configure(options = {}) {
  if (typeof options?.systemsFor === "function") systemsFor = options.systemsFor;
  return { entity: ENTITY, run: RUN_ID };
}

function etDate(ms) {
  const d = new Date(Number(ms));
  return Number.isFinite(d.getTime()) ? ET_DATE.format(d) : null;
}

function isoOrNull(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function roundOrNull(value, digits = 6) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

// The extra numbers the gate attached to a verdict, kept as evidence rather than
// promoted to columns: how far the print was from the anchor, how late it was executed,
// which condition refused it — whatever that particular refusal was decided on.
function detailOf(verdict) {
  const detail = {
    age_ms: roundOrNull(verdict.ageMs, 0),
    execution_ms: roundOrNull(verdict.executionMs, 0),
    previous_execution_ms: roundOrNull(verdict.previousExecutionMs, 0),
    lag_ms: roundOrNull(verdict.lagMs, 0),
    move_pct: roundOrNull(verdict.movePct, 6),
    anchor_price: roundOrNull(verdict.anchorPrice, 4),
    massive_age_ms: roundOrNull(verdict.massiveAgeMs, 0),
  };
  for (const key of Object.keys(detail)) if (detail[key] == null) delete detail[key];
  return detail;
}

// Record one refused or quarantined price. NEVER throws and never awaits: a monitoring
// write may not become a trading failure.
export function record(verdict) {
  try {
    if (!verdict) return;
    const tier = String(verdict.tier || "");
    if (tier !== "refuse" && tier !== "quarantine") return;

    const nowMs = Date.now();
    const receivedIso = new Date(nowMs).toISOString();
    const symbol = String(verdict.symbol || "").toUpperCase();
    const source = String(verdict.source || "unknown");

    let systems = [];
    try {
      systems = Array.from(new Set((systemsFor(symbol) || []).map((s) => String(s).toUpperCase())));
    } catch (_) {
      systems = [];
    }

    seq = (seq + 1) % 1000000;
    const key = `rej|${source}|${symbol}|${receivedIso}|${seq}`;

    state.buffer.push({
      id: key,
      rejection_key: key,
      source,
      tier,
      code: String(verdict.code || ""),
      reason: String(verdict.reason || ""),
      symbol,
      price: roundOrNull(verdict.price, 6),
      print_time: isoOrNull(verdict.printMs),
      received_at: receivedIso,
      print_age_ms: roundOrNull(verdict.ageMs, 0),
      trade_date: etDate(nowMs),
      systems,
      position_count: systems.length,
      worker_run: RUN_ID,
      detail: detailOf(verdict),
    });
    state.recorded += 1;

    // Hard ceiling. A bridge outage during a TRF burst must not grow this process.
    while (state.buffer.length > MAX_BUFFER) {
      state.buffer.shift();
      state.dropped += 1;
    }

    if (state.buffer.length >= FLUSH_ROWS) flush().catch(() => {});
  } catch (_) {
    // Recording is a bystander: it can never surface as a trading error.
  }
}

// Write what is buffered. Called on the interval, when a batch fills, and at shutdown.
// Never overlaps itself, and one failed batch is re-queued (bounded) rather than lost.
export async function flush() {
  if (!bridgeConfigured() || state.flushing || state.buffer.length === 0) return state.written;
  state.flushing = true;
  try {
    let batches = 0;
    while (state.buffer.length > 0 && batches < MAX_BATCHES_PER_FLUSH) {
      const batch = state.buffer.splice(0, FLUSH_ROWS);
      batches += 1;
      const now = new Date().toISOString();
      try {
        await bulkUpsertEntities(
          ENTITY,
          batch.map((row) => ({ created_date: row.received_at, updated_date: now, ...row }))
        );
        state.written += batch.length;
        state.last_flush_at = now;
      } catch (err) {
        state.errors += 1;
        state.last_error = String(err?.message || err);
        const room = Math.max(0, MAX_BUFFER - state.buffer.length);
        if (room > 0) state.buffer.unshift(...batch.slice(batch.length - room));
        state.dropped += Math.max(0, batch.length - room);
        break;
      }
    }
  } finally {
    state.flushing = false;
  }
  return state.written;
}

export function startFlusher() {
  if (timer) return true;
  if (!bridgeConfigured()) return false;
  timer = setInterval(() => { flush().catch(() => {}); }, FLUSH_MS);
  timer.unref?.();
  return true;
}

export function stats() {
  return {
    entity: ENTITY,
    run: RUN_ID,
    recorded: state.recorded,
    buffered: state.buffer.length,
    written: state.written,
    dropped: state.dropped,
    errors: state.errors,
    flushing: state.flushing,
    last_flush_at: state.last_flush_at,
    last_error: state.last_error,
  };
}