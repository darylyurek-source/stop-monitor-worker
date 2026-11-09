// tradeConditions.js — is a Massive stream print a price DART may act on?
//
// ONE QUESTION, ASKED AT THE DOOR. Every Massive print walks through worker.js
// onMassivePrice(); this module answers, from the frame's own fields, whether the TAPE
// describes that print as a regular-session price for the present. It is not a price
// heuristic: it reads the sale conditions the SIP stamped on the print, and the two
// timestamps that say when the trade happened versus when it was reported.
//
// WHY IT EXISTS. On 2026-11-09 between 14:51:46 and 14:53:28 ET a FINRA Trade Reporting
// Facility (TRF 201, exchange 4 = the ADF) flushed a backlog of overnight executions onto
// Tape C, market-wide — AAPL alone carried 1,930 of them in those three minutes. Each
// print was stamped with the moment it was TAPED, not the moment it traded, so it looked
// current to anything that read only the price. Eight DART positions were closed on prices
// 4-14 % away from the book. The tape had labelled every one of them: condition 13,
// "Extended Hours (Sold Out Of Sequence)".
//
// 1. SALE CONDITIONS (Massive: /v3/reference/conditions, mapped to the SIP flags)
//    Massive publishes an update rule per condition — whether it moves the consolidated
//    high/low/close. Two extended-hours conditions carry "no":
//
//      12  Form T/Extended Hours                  (SIP 'T')  high/low: no   volume: yes
//      13  Extended Hours (Sold Out Of Sequence)  (SIP 'U')  high/low: no   volume: yes
//
//    Neither belongs to the session's price range, so neither may reprice a live position.
//    Both are refused here.
//
//    ALLOWED on purpose, and the distinction is Massive's own documented one:
//      37  Odd Lot Trade           — a real, current price at odd-lot size. The genuine
//                                    EWTX exit of 2026-11-09 was such a print, taped with
//                                    0 s lag; refusing 37 would have refused it.
//      32  Sold (Out Of Sequence)  — a regular-hours sale reported late. It DOES update
//                                    the consolidated high/low, so it is a session price.
//      14  Intermarket Sweep       — an in-session sweep price.
//    A print carrying no conditions at all is judged on its timestamps alone.
//
// 2. EXECUTION TIME versus REPORTING TIME (pt and t, on the same frame)
//    pt = when the trade occurred at the exchange or TRF.
//    t  = when the SIP received and published it.
//    A live print carries both within milliseconds of each other — measured on this feed
//    the gap is under 10 ms. A print whose execution precedes its arrival by more than
//    MAX_EXECUTION_LAG_MS is a re-publication of an old trade whatever its conditions say:
//    the seven prints of 2026-11-09 arrived 11.0 to 14.8 hours after they traded. The
//    comparison uses the two PROVIDER stamps, so a clock skew in this worker cannot
//    produce a false refusal. pt is omitted on OTC trades through the FINRA ORF
//    (exchange 62); those are judged on their conditions alone.
//
// Nothing here sizes, prices or decides a trade. It answers one yes/no about provenance.

// Extended-hours sale conditions: documented as NOT updating the consolidated high/low.
export const EXTENDED_HOURS_CONDITIONS = {
  12: "Form T/Extended Hours",
  13: "Extended Hours (Sold Out Of Sequence)",
};

// How far behind its own arrival a trade may have been executed and still describe the
// present. Members must report within seconds; two minutes is a wide allowance that still
// refuses every re-publication measured here (the smallest gap observed was 11.0 hours).
export const MAX_EXECUTION_LAG_MS = 120000;

function formatLag(lagMs) {
  const hours = lagMs / 3600000;
  if (hours >= 1) return `${hours.toFixed(1)}h`;
  const minutes = lagMs / 60000;
  if (minutes >= 1) return `${minutes.toFixed(1)}m`;
  return `${(lagMs / 1000).toFixed(1)}s`;
}

// How far a stamp may sit AHEAD of this process's clock and still be a price. A venue clock
// is never exactly ours; without this allowance a symbol whose venue runs a few seconds
// fast would have every print refused for the whole session — a freeze produced by a clock.
export const FUTURE_TOLERANCE_MS = 5000;

// HOW OLD — never HOW FAR (2026-11-09). This is the whole freshness test: the print's age
// against a limit this process's clock measures. It takes no price, so no genuine move can
// be refused for being large. A halt resume 20 % away, an opening gap and a news spike are
// all prices; a print from a finished tape is not.
export function assessFreshness({ stampMs, nowMs = Date.now(), maxAgeMs }) {
  const stamp = Number(stampMs);
  if (!Number.isFinite(stamp) || stamp <= 0) return { ok: false, reason: "carries no timestamp" };
  const ageMs = nowMs - stamp;
  if (ageMs < -FUTURE_TOLERANCE_MS) {
    return { ok: false, reason: `stamp is ${Math.round(-ageMs / 1000)}s in the future`, ageMs };
  }
  if (ageMs > Number(maxAgeMs)) {
    return { ok: false, reason: `stamp is ${(ageMs / 1000).toFixed(1)}s old`, ageMs };
  }
  return { ok: true, ageMs };
}

// The verdict for one print.
//   conditions    — the frame's `c`, the sale conditions the SIP stamped on it.
//   participantMs — the frame's `pt`, execution time, already normalised to epoch ms.
//   tapeMs        — the frame's `t`, SIP publication time, already normalised to epoch ms.
export function assess({ conditions, participantMs, tapeMs } = {}) {
  for (const code of Array.isArray(conditions) ? conditions : []) {
    const name = EXTENDED_HOURS_CONDITIONS[Number(code)];
    if (name) {
      return { eligible: false, reason: `sale condition ${Number(code)} ${name}` };
    }
  }

  const executedMs = Number(participantMs);
  const tapedMs = Number(tapeMs);
  if (Number.isFinite(executedMs) && executedMs > 0 && Number.isFinite(tapedMs) && tapedMs > 0) {
    const lagMs = tapedMs - executedMs;
    if (lagMs > MAX_EXECUTION_LAG_MS) {
      return {
        eligible: false,
        reason: `executed ${formatLag(lagMs)} before it was taped`,
        lagMs,
      };
    }
  }

  return { eligible: true, reason: null };
}