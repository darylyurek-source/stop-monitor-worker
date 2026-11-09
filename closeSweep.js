// closeSweep.js — the 16:00 ET session end must not wait for a trade to print.
//
// WHY THIS EXISTS (2026-11-09). Every exit DART makes — the hard stop, the protective stop,
// the price trail AND the 16:00 close — is decided inside tickDecisionCore.decideTick, which
// runs only when a price arrives for that position. Nothing else may write: all four accounts
// are engine=render / mode=live, so manageClone returns without touching a position and
// Base44's own session close never runs. A symbol that stops printing therefore has no closing
// procedure at all.
//
// This module supplies the missing half of that guarantee: a TIMER, not a tick. Once the
// session mark has passed it walks the live book and closes every position still open, using
// the SAME decision path and guarded write a tick uses. A position that survived an earlier
// session is closed at the next scheduled mark under the same rule — never forced intraday.
//
// THE PRICE IS RESOLVED AT THE CLOSE (2026-11-09), not remembered from whenever the symbol last
// printed: closeQuote.resolveClosePrice asks for a current price first and only falls back to an
// older one — labelled and counted — when no current price exists at all. Closing at an
// hour-old price would record a fill that never happened in the market at the close.
//
// It changes no rule: decideTick still decides, with the same precedence (a genuine stop at the
// bell keeps its own reason; the session end is close_1600), and nothing here presses, sizes,
// re-enters or re-prices anything. A halted account is refused by decideTick itself.
//
// The book and the writer are ARGUMENTS, not imports, so the sweep can be driven end to end
// against a simulated book — no database, no socket — and the guarantee stays checkable.

import { etNow, isDueForClose, closePriceFor } from "./closeWindow.js";
import { ageText } from "./closeQuote.js";
import { decideTick } from "./tickDecisionCore.js";

// How often the sweep runs. Cheap: it reads the in-memory book and writes only for a position
// that is actually still open after its session has ended.
export const CLOSE_SWEEP_INTERVAL_MS = 15000;

//   systems   — the accounts this process is allowed to write (engine=render, mode=live)
//   ids(sys)  — the position ids the book holds for that account
//   get(sys,i)— one position record from the book
//   apply     — the guarded write a tick uses (engineLive.apply)
//   reload    — re-read one position into the book after a write
//   resolvePrice — async (position) => { price, basis, ageMs, fresh } | null, the price to
//                 close at (closeQuote.resolveClosePrice). When omitted, only the prices this
//                 process already holds are used (closePriceFor).
//   priceFor  — the last accepted price this process holds for a symbol, or null
//
// Idempotent: the book's status guard refuses a second close, and an already-closed position is
// never selected.
export async function runSessionClose({
  systems = [],
  ids = () => [],
  get = () => null,
  apply = async () => ({ applied: false, reason: "no_writer" }),
  reload = async () => {},
  resolvePrice = null,
  priceFor = () => null,
  nowMs = Date.now(),
  log = console.log,
  warn = console.warn,
} = {}) {
  if (!systems.length) return { due: 0, closed: 0, systems: [] };

  const { minutes } = etNow(nowMs);
  let due = 0;
  let closed = 0;
  let stale = 0;

  for (const system of systems) {
    for (const id of ids(system)) {
      const pos = get(system, id);
      if (!isDueForClose({ position: pos, nowMinutes: minutes })) continue;
      due += 1;

      // Resolve the price AT THE CLOSE. A resolver that throws must not strand the position:
      // it falls back to the prices this process already holds.
      let source = null;
      if (typeof resolvePrice === "function") {
        try {
          source = await resolvePrice(pos);
        } catch (err) {
          warn(`[close] ${system} ${pos.symbol}: price resolver failed (${err?.message || err}) — using held prices`);
          source = null;
        }
      }
      if (!source) source = closePriceFor(pos, priceFor);

      if (!source) {
        log(`[close] ${system} ${pos.symbol}: session ended and still open, but no price to close it at — retrying next sweep`);
        continue;
      }

      // A close at a price that no longer describes the market is recorded ONLY when nothing
      // current exists (a halted symbol has no current price — its last print is the market),
      // and it is labelled and counted rather than passed off as a market fill.
      const isStale = source.fresh === false;
      if (isStale) {
        stale += 1;
        warn(
          `[close] ${system} ${pos.symbol}: NO CURRENT PRICE — closing at ${source.price} ` +
          `(${source.basis}, ${ageText(source.ageMs)}) — this fill may not match the closing market`
        );
      }

      const verdict = decideTick({
        system,
        position: pos,
        price: source.price,
        nowIso: new Date(nowMs).toISOString(),
      });

      // An exit verdict names its rule in exit_reason; reason is for refusals and holds.
      const rule = verdict?.exit_reason || verdict?.event || null;

      if (!verdict || verdict.action !== "exit") {
        log(`[close] ${system} ${pos.symbol}: due for the session close, engine answered ${verdict?.action || "nothing"} (${verdict?.reason || "no reason"}) — untouched, retrying next sweep`);
        continue;
      }

      const result = await apply({ system, positionId: id, symbol: pos.symbol }, verdict);
      if (result?.applied) {
        closed += 1;
        log(
          `[close] ${system} ${pos.symbol} CLOSED ${rule} @${source.price} (${source.basis}` +
          `${isStale ? `, ${ageText(source.ageMs)} — NOT a market price` : ""}) ` +
          `pl=${Math.round(Number(verdict.pl_raw ?? verdict.gross_pl) || 0)} — closed by the clock, no tick needed`
        );
        try {
          await reload(system, id);
        } catch (_) {}
      } else if (result?.reason !== "guard_miss" && result?.reason !== "not_owner") {
        log(`[close] ${system} ${pos.symbol}: close not written (${result?.reason || "unknown"}) — retrying next sweep`);
      }
    }
  }

  return { due, closed, stale, systems };
}