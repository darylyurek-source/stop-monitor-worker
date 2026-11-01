// bridge.js — the worker's own path to Cloud SQL, with no Base44 in between.
//
// This is the module that removes the tick-round-trip. Base44's shared/db.ts does
// the same job from inside a function; here it runs in the worker process, so a
// decision costs one HTTP round trip to the Cloud Run bridge (measured p50 78 ms,
// p99 148 ms) instead of a function invocation plus that round trip.
//
// Every operation used here is an EXISTING, whitelisted bridge operation — the
// bridge accepts no arbitrary SQL, so nothing new is exposed by the worker holding
// the key:
//   listOpenPositionsInTable   read the book at startup / on resync
//   getPositionInTable         re-read one position after a guard miss
//   updatePositionInTable      the guarded write (the atomicity the stops rely on)
//   listIntradayCandles        seed the 1-minute series
//   bulkUpsertEntities         shadow-run rows, and nothing else
//
// Read-only by construction until a caller asks for a write: loadBook() and
// seedCandles() only ever read, and the only write path is updateGuarded(), which
// the shadow runtime never calls.

import fetch from "node-fetch";

const BRIDGE_URL = (process.env.BRIDGE_URL || "").replace(/\/$/, "");
const BRIDGE_API_KEY = process.env.BRIDGE_API_KEY;
const TIMEOUT_MS = 8000;

// Rolling round-trip record, so the worker can report its own latency instead of
// us inferring it. Bounded — the array never grows past SAMPLE_CAP.
const SAMPLE_CAP = 2000;
const samples = [];
const state = { calls: 0, errors: 0 };

export function bridgeConfigured() {
  return Boolean(BRIDGE_URL && BRIDGE_API_KEY);
}

export function latencySummary() {
  if (!samples.length) return { calls: state.calls, errors: state.errors, n: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return {
    calls: state.calls,
    errors: state.errors,
    n: sorted.length,
    p50: q(0.5),
    p95: q(0.95),
    max: sorted[sorted.length - 1],
  };
}

export async function bridge(operation, params = {}, timeoutMs = TIMEOUT_MS) {
  if (!bridgeConfigured()) {
    throw new Error("bridge not configured (BRIDGE_URL / BRIDGE_API_KEY)");
  }
  const started = Date.now();
  state.calls += 1;
  try {
    const res = await fetch(`${BRIDGE_URL}/db`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${BRIDGE_API_KEY}` },
      body: JSON.stringify({ operation, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) {
      throw new Error(`${operation}: HTTP ${res.status} ${body.error || "no detail"}`);
    }
    return body.result;
  } catch (err) {
    state.errors += 1;
    throw err;
  } finally {
    samples.push(Date.now() - started);
    if (samples.length > SAMPLE_CAP) samples.splice(0, samples.length - SAMPLE_CAP);
  }
}

// --- positions ---------------------------------------------------------------

export async function listOpen(table, limit = 100) {
  const rows = await bridge("listOpenPositionsInTable", { table, limit });
  return Array.isArray(rows) ? rows : [];
}

export async function getPosition(table, id) {
  if (!id) throw new Error("getPosition requires an id");
  return bridge("getPositionInTable", { table, id });
}

// The guarded write. `expected` is a column-equality guard: the UPDATE fires only
// if every listed column still holds the expected value, so a press can never
// apply twice and a closed position can never be closed again. Returns the updated
// row, or null when the guard refused (the caller must NOT retry blindly — the
// position is already in the guarded-against state).
export async function updateGuarded(table, id, fields, expected) {
  if (!id) throw new Error("updateGuarded requires an id");
  if (!fields || Object.keys(fields).length === 0) throw new Error("updateGuarded requires fields");
  return bridge("updatePositionInTable", { table, id, fields, expected: expected || {} });
}

// --- candles -----------------------------------------------------------------

export async function listCandles(symbol, date, limit = 2000) {
  const rows = await bridge("listIntradayCandles", { symbol, scan_date: date, limit });
  return Array.isArray(rows) ? rows : [];
}

// --- supporting entities (shadow rows only) ----------------------------------

export async function bulkUpsertEntities(entity_name, records) {
  if (!Array.isArray(records) || records.length === 0) return { created: 0, updated: 0, total: 0 };
  return bridge("bulkUpsertEntities", { entity_name, records });
}

export async function filterEntities(opts) {
  const rows = await bridge("filterEntities", opts);
  return Array.isArray(rows) ? rows : [];
}