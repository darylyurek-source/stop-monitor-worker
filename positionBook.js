// positionBook.js — the worker's in-memory book of open positions.
//
// THE POINT OF THIS FILE: a tick must never pay for a read. The book is loaded
// once through the bridge, kept in memory, and mutated in place by each decision;
// only an ACTUAL change is written back, through the bridge's guarded update.
//
// So the hot path is:
//     tick -> decide against memory (microseconds) -> one guarded write IF acting
//
// which is why a decision + durable record lands in ~80-150 ms rather than behind a
// Base44 function invocation.
//
// Writes are guarded on the fields the decision depended on (status, and the press
// or partial flag it is about to set), so a decision can never be applied twice —
// the same protection shared/cloneTick.ts gets from its own expected-state writes.
//
// A guard miss returns { persisted: false, guardMiss: true } and re-reads the row.
// The caller must NOT retry blindly: the position is already in the guarded state.

import { listOpen, getPosition, updateGuarded } from "./bridge.js";

export const TABLE_FOR_SYSTEM = {
  ANEW: "positions_anew",
  B: "positions_b",
};

const books = new Map(); // system -> Map(id -> position)
const stats = { loads: 0, writes: 0, guardMisses: 0, writeErrors: 0 };

export function statsSummary() {
  return { ...stats };
}

export function tableFor(system) {
  return TABLE_FOR_SYSTEM[String(system || "").toUpperCase()] || null;
}

function bookOf(system) {
  let m = books.get(system);
  if (!m) {
    m = new Map();
    books.set(system, m);
  }
  return m;
}

export function get(system, id) {
  return bookOf(system).get(id) || null;
}

export function ids(system) {
  return [...bookOf(system).keys()];
}

export function size(system) {
  return bookOf(system).size;
}

// Replace a system's book with the database's open positions. Called at startup
// and on resync; a position that closed elsewhere disappears from the book.
export async function load(system) {
  const table = tableFor(system);
  if (!table) return 0;
  const rows = await listOpen(table, 200);
  const next = new Map();
  for (const row of rows) if (row?.id) next.set(String(row.id), row);
  books.set(system, next);
  stats.loads += 1;
  return next.size;
}

export async function reloadOne(system, id) {
  const table = tableFor(system);
  if (!table || !id) return null;
  const row = await getPosition(table, id);
  if (row) bookOf(system).set(String(id), row);
  else bookOf(system).delete(String(id));
  return row;
}

// The guard for one patch: the fields the decision depended on, taken from the
// pre-image. A press guards the flag it is about to set; an exit guards status.
function guardFor(pos, patch) {
  const guard = { status: pos.status };
  if (patch.partial_profit_taken) guard.partial_profit_taken = false;
  if (patch.pressed_3r) guard.pressed_3r = false;
  else if (patch.pressed_2r) guard.pressed_2r = false;
  else if (patch.pressed_1r && !pos.pressed_1r) guard.pressed_1r = false;
  return guard;
}

function withoutUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) if (v !== undefined) out[k] = v;
  return out;
}

// Apply a decision's patches to the book and persist the resulting fields.
//
//   patches — decideTick's prior_patches (state writes that precede the decision)
//             followed by its patch. Later keys win, exactly as applying them in
//             order would.
//
// Returns { persisted, fields, guardMiss, error }.
export async function apply(system, id, patches) {
  const pos = get(system, id);
  if (!pos) return { persisted: false, reason: "position_not_in_book" };

  const merged = {};
  for (const p of Array.isArray(patches) ? patches : [patches]) {
    if (p && typeof p === "object") Object.assign(merged, p);
  }
  const fields = withoutUndefined(merged);
  if (!Object.keys(fields).length) return { persisted: false, reason: "no_fields" };

  // The guard is taken from the PRE-IMAGE, before the patch is merged into the
  // book. Taken afterwards it would guard the position against the state it is
  // about to be put into (an exit would require status = 'closed') and refuse
  // every write.
  const guard = guardFor(pos, fields);

  Object.assign(pos, fields); // optimistic: the book reflects the decision at once

  const table = tableFor(system);
  try {
    const updated = await updateGuarded(table, id, fields, guard);
    stats.writes += 1;
    if (!updated) {
      stats.guardMisses += 1;
      await reloadOne(system, id); // the real state wins; do not retry blindly
      return { persisted: false, guardMiss: true, fields };
    }
    Object.assign(pos, updated);
    return { persisted: true, fields };
  } catch (err) {
    stats.writeErrors += 1;
    // The write failed: the book must not keep a change the database never took.
    await reloadOne(system, id).catch(() => {});
    return { persisted: false, error: String(err?.message || err), fields };
  }
}