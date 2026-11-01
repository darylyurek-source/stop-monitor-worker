// engineLive.js — THE RENDER LIVE WRITER.
//
// This is the file that makes the Render engine an EXECUTOR rather than an observer.
// It takes a verdict from the portable engine and persists it through the worker's
// guarded position write, so a stop, a press, a partial sale, an exit or a grid step
// is decided AND recorded without a Base44 function in the path.
//
// TWO INDEPENDENT GATES, both required, both written down in the switchboard:
//
//     EngineSwitch.engine === "render"   → Base44's tick handler returns a no-op,
//                                          so Base44 cannot write this account.
//     EngineSwitch.mode   === "live"     → this module is allowed to write.
//
// While either is missing, apply() refuses every verdict and the tick is forwarded
// to Base44 exactly as it is today. So the writer can be deployed, tested and idle
// for as long as needed: it only ever trades when both values say so. `mode: shadow`
// with `engine: base44` is the observation run and writes nothing.
//
// WHAT IT DOES NOT DO, deliberately:
//   • hold verdicts are not written. A hold's patch is display-only (current price,
//     current P&L, peak) and Base44's manager workflows keep those fresh — writing
//     them once per tick would add a database round trip per price for no decision.
//   • a verdict that needs a Vector the worker could not build (needs_vector) is
//     never guessed. It is logged as a data gap and nothing is written.
//   • no rule, threshold, size, fee or exit level is computed here. Everything comes
//     from the verdict; this module only persists it.

import {
  apply as applyToBook,
  reloadOne,
  tableFor,
} from "./positionBook.js";

// Verdicts that change position state and must be persisted.
const WRITE_ACTIONS = new Set(["exit", "press", "partial", "grid"]);

let switches = new Map(); // system -> { engine, mode }

const stats = {
  writes: 0,
  persisted: 0,
  guardMisses: 0,
  errors: 0,
  holds: 0,
  needsVector: 0,
  refused: 0,
};

export function statsSummary() {
  return { ...stats, systems: liveSystems() };
}

// Which accounts are handed to this writer (engine = render AND mode = live).
export function liveSystems() {
  return [...switches.entries()]
    .filter(([, s]) => s.engine === "render" && s.mode === "live")
    .map(([system]) => system);
}

export function setModes(list) {
  const next = new Map();
  for (const row of Array.isArray(list) ? list : []) {
    const system = String(row?.system || "").toUpperCase();
    if (!system || !tableFor(system)) continue;
    if (String(row.mode || "off") === "off") continue;
    next.set(system, {
      engine: String(row.engine || "base44").toLowerCase() === "render" ? "render" : "base44",
      mode: String(row.mode || "off").toLowerCase(),
    });
  }
  switches = next;
  return statsSummary();
}

// True only when this account's ticks belong to Render AND may be written.
export function ownsWrites(system) {
  const s = switches.get(String(system || "").toUpperCase());
  return Boolean(s && s.engine === "render" && s.mode === "live");
}

// Whether the tick must be forwarded to Base44. False only while Render owns writes —
// that is the single-writer guarantee seen from the tick path.
export function shouldForward(system) {
  return !ownsWrites(system);
}

// Persist one verdict. Never throws — a write failure is logged and the book is
// reloaded from the database, exactly as the shadow runtime treats any bad read.
export async function apply(ref, verdict) {
  if (!ownsWrites(ref.system) || !verdict) {
    stats.refused += 1;
    return { applied: false, reason: "not_owner" };
  }

  if (verdict.action === "needs_vector") {
    stats.needsVector += 1;
    console.error(
      `[live] ${ref.system} ${ref.positionId}: no Vector available for ${verdict.pending_step || "checkpoint"} — nothing written`
    );
    return { applied: false, reason: "needs_vector" };
  }

  if (!WRITE_ACTIONS.has(verdict.action)) {
    stats.holds += 1;
    return { applied: false, reason: verdict.action };
  }

  const patches = [];
  if (Array.isArray(verdict.prior_patches)) patches.push(...verdict.prior_patches);
  if (verdict.patch) patches.push(verdict.patch);

  stats.writes += 1;
  const result = await applyToBook(ref.system, ref.positionId, patches);

  if (result.persisted) {
    stats.persisted += 1;
    return { applied: true, fields: result.fields };
  }
  if (result.guardMiss) {
    stats.guardMisses += 1;
    return { applied: false, reason: "guard_miss" };
  }
  stats.errors += 1;
  return { applied: false, reason: result.error || result.reason || "write_failed" };
}

// Re-read one position from the database (used after a write to adopt what landed).
export async function refresh(system, id) {
  return reloadOne(system, id);
}