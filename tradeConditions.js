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

// ---------------------------------------------------------------------------
// THE GATE — one door for every price source (2026-11-09, second cut)
// ---------------------------------------------------------------------------
//
// The first cut above guarded the Massive STREAM only. Measured against the day, that left
// five other doors: the Massive snapshot used to recover a quiet symbol and to price the
// close, the Finnhub standby socket, the Finnhub REST quote, the close resolver's own held
// price, and Finnhub-primary mode — which applied no gate at all. Two of them did not merely
// lack a rule, they had a rule that ADMITTED an unprovenanced print ("judged on the routing
// staleness alone"). A price could therefore be judged to six different standards depending
// on which door it came through.
//
// So every price now answers the same four questions, in the same order, here:
//
//   1. IS IT A PRICE?      a finite positive number, from a source this file knows.
//   2. WHAT IS IT?         its sale conditions (Massive only — Finnhub's codes are a
//                          different namespace and are never read as if they were the SIP's).
//   3. HOW OLD IS IT?      its own stamp against that source's limit. AGE, never MAGNITUDE:
//                          no test in this file takes a price, so a halt resume 20 % away, an
//                          opening gap and a news spike are all prices. The 3 % band stays
//                          removed — it refused good prices and, worse, froze symbols.
//   4. DOES THE TAPE MOVE BACKWARDS?  a print whose execution time sits further behind the
//                          last accepted execution for that symbol than
//                          REGRESSION_TOLERANCE_MS is a RE-PUBLICATION of an earlier trade,
//                          whatever door it arrived on. This is the test that catches a
//                          taped-late print on a path that carries no sale conditions.
//
// Three answers, not two:
//
//   use        fresh and provenanced — valued, rules evaluated, presses and exits written.
//   quarantine fresh but with NO execution stamp (no pt, no trft). It may value a position;
//              it may not close one. The worker replaces it with a corroborating snapshot
//              judged by this same gate (worker.js confirmUnprovenanced). A fresh print with
//              nothing to judge it is never silently admitted — and never silently dropped
//              either, because a symbol with no price has no stop and no close.
//   refuse     dropped and counted. The book is untouched; the next print decides.
//
// Nothing here sizes, prices, or decides a trade. It answers what a price IS.

// Each source's own freshness limit. The stream is milliseconds behind; a snapshot or a quote
// may be up to a minute old and still describe the market. A source with no entry here is
// refused rather than given a default — an unknown door is not a door.
export const SOURCE_LIMITS = Object.freeze({
  massive_stream: 10000,
  massive_snapshot: 60000,
  finnhub_stream: 60000,
  finnhub_quote: 60000,
});

// How far an execution time may walk backwards and still be a genuine out-of-order print.
// Exchanges report the same instant in slightly different orders; minutes do not.
export const REGRESSION_TOLERANCE_MS = 2000;

// symbol -> the latest execution time this gate has accepted. Ratchets forward only.
const lastExecution = new Map();

// Counted by tier, by source and by reason code, so a path that has started refusing
// everything is visible in the heartbeat instead of looking like a quiet market.
const gateCounts = { use: 0, quarantine: 0, refuse: 0, byCode: {}, bySource: {} };

function countVerdict(tier, source, code) {
  gateCounts[tier] += 1;
  const per = gateCounts.bySource[source] || { use: 0, quarantine: 0, refuse: 0 };
  per[tier] += 1;
  gateCounts.bySource[source] = per;
  if (code) gateCounts.byCode[code] = (gateCounts.byCode[code] || 0) + 1;
}

export function gateSummary() {
  return {
    use: gateCounts.use,
    quarantine: gateCounts.quarantine,
    refuse: gateCounts.refuse,
    byCode: { ...gateCounts.byCode },
    bySource: Object.fromEntries(
      Object.entries(gateCounts.bySource).map(([k, v]) => [k, { ...v }])
    ),
    symbolsTracked: lastExecution.size,
  };
}

// Test support only: forget every execution time and count this process has recorded.
export function resetGate() {
  lastExecution.clear();
  gateCounts.use = 0;
  gateCounts.quarantine = 0;
  gateCounts.refuse = 0;
  gateCounts.byCode = {};
  gateCounts.bySource = {};
}

// The verdict for one price, from any source.
//   source        — one of SOURCE_LIMITS.
//   symbol        — the symbol the price belongs to (the tape registry is per symbol).
//   price         — the number that would reach a rule.
//   stampMs       — that source's own stamp for the print (tape t, snapshot lastTrade.t,
//                   Finnhub trade t, quote t). REQUIRED: an unstamped price is refused.
//   conditions    — Massive's sale conditions only.
//   participantMs — Massive's pt (execution time at the exchange or TRF).
//   trfMs         — Massive's trft (when the TRF received it), used when pt is absent.
export function admitPrice({
  source,
  symbol,
  price,
  stampMs,
  nowMs = Date.now(),
  conditions = [],
  participantMs = null,
  trfMs = null,
} = {}) {
  const src = String(source || "");
  const sym = String(symbol || "").toUpperCase();
  const limit = SOURCE_LIMITS[src];

  const verdict = (tier, code, reason, extra) => {
    countVerdict(tier, src, code);
    return { tier, code, reason, source: src, symbol: sym, ...extra };
  };

  // 1. IS IT A PRICE, FROM A DOOR WE KNOW?
  if (!limit) return verdict("refuse", "unknown_source", `no admission profile for source "${src}"`);
  const numeric = Number(price);
  if (!Number.isFinite(numeric) || numeric <= 0) return verdict("refuse", "bad_price", "not a positive price");

  // 2. WHAT IS IT? Only Massive stamps SIP sale conditions. Finnhub's condition codes are a
  //    different namespace, so a Finnhub price is judged on its stamp alone — never mapped.
  for (const code of Array.isArray(conditions) ? conditions : []) {
    const name = EXTENDED_HOURS_CONDITIONS[Number(code)];
    if (name) return verdict("refuse", "extended_hours", `sale condition ${Number(code)} ${name}`);
  }

  // 3. HOW OLD IS IT? One freshness implementation (assessFreshness), one limit per source.
  const fresh = assessFreshness({ stampMs, nowMs, maxAgeMs: limit });
  if (!fresh.ok) {
    const numericStamp = Number(stampMs);
    const code = !Number.isFinite(numericStamp) || numericStamp <= 0
      ? "no_stamp"
      : Number(fresh.ageMs) < 0 ? "future" : "stale";
    return verdict("refuse", code, `${src} price ${fresh.reason} (limit ${limit / 1000}s)`, { ageMs: fresh.ageMs });
  }

  // 4. DID IT TRADE WHEN IT ARRIVED? A print executed before it was taped is a re-publication
  //    whatever its conditions say, and a print whose execution time walks behind one already
  //    accepted is an old trade arriving late.
  const executedMs = Number(participantMs) > 0 ? Number(participantMs) : null;
  const receivedMs = Number(trfMs) > 0 ? Number(trfMs) : null;
  const tapeMs = Number(stampMs);

  if (executedMs != null) {
    const lagMs = tapeMs - executedMs;
    if (lagMs > MAX_EXECUTION_LAG_MS) {
      return verdict("refuse", "late_print", `executed ${formatLag(lagMs)} before it was taped`, { lagMs });
    }
  }

  // The print's own execution time: the venue's (pt), else the TRF's receipt (trft), else —
  // for a source whose stamp IS the trade time — the stamp itself.
  const executionMs = executedMs ?? receivedMs ?? tapeMs;
  const previous = lastExecution.get(sym);
  if (previous != null && executionMs < previous - REGRESSION_TOLERANCE_MS) {
    return verdict(
      "refuse",
      "regressed",
      `execution time walks back ${((previous - executionMs) / 1000).toFixed(1)}s behind the last accepted print`,
      { executionMs, previousExecutionMs: previous }
    );
  }
  lastExecution.set(sym, Math.max(previous ?? executionMs, executionMs));

  // Provenance: only a Massive stream print can be missing it. Every other source's stamp IS
  // its execution time, so it is provenanced by construction.
  const provenanced = src !== "massive_stream" || executedMs != null || receivedMs != null;
  if (!provenanced) {
    return verdict(
      "quarantine",
      "no_execution_stamp",
      "print carries no execution stamp (neither pt nor trft) — may value a position, may not close one",
      { executionMs }
    );
  }

  return verdict("use", null, null, { ageMs: fresh.ageMs, executionMs });
}