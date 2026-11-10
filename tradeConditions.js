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
//   3. HOW OLD IS IT?      its own stamp against that source's limit. A price is never
//                          REFUSED for being far from another price: a halt resume 20 %
//                          away, an opening gap and a news spike are all prices.
//   4. DOES THE TAPE MOVE BACKWARDS?  a print whose execution time sits further behind the
//                          last accepted execution for that symbol than
//                          REGRESSION_TOLERANCE_MS is a RE-PUBLICATION of an earlier trade,
//                          whatever door it arrived on. This is the test that catches a
//                          taped-late print on a path that carries no sale conditions.
//   5. IS ITS DOOR THE RIGHT ONE?  while the stream is printing a symbol, a slower door may
//                          not price it (MASSIVE_ACTIVE_MS / PREVAILING_MAX_AGE_MS).
//   6. IS IT THE SAME MARKET?  a print far from the last ACCEPTED price may value a position
//                          but may not close one until a second print agrees with it
//                          (MAGNITUDE_JUMP_PCT / MAGNITUDE_WINDOW_MS). Quarantine, never
//                          refusal, so a symbol can never freeze on a genuine move.
//
// Three answers, not two:
//
//   use        fresh and provenanced — valued, rules evaluated, presses and exits written.
//   quarantine fresh but with NO execution stamp (no pt, no trft), or far enough from the last
//              accepted price that it needs agreement. It may value a position; it may not
//              close one. Since 2026-11-10 the worker no longer substitutes a snapshot for it
//              (confirmUnprovenanced is gone): it is dropped and counted, and the symbol's
//              next provenanced print decides. A fresh print with nothing to judge it is never
//              silently admitted — and never silently passed as a price either.
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

// ---------------------------------------------------------------------------
// TWO ADDITIONS, 2026-11-10 BEFORE THE OPEN (items 1 of the post-mortem)
// ---------------------------------------------------------------------------
// Measured on that morning's session: 21 of 23 fills sat outside Massive's own 1-minute
// range for the minute they executed in. QNT closed at 41.34 while that minute traded
// 42.01-42.42; ALMR at 31.71 against 30.90-31.05; OMH was OPENED at 21.30 at 09:40:07
// while the 09:40 minute opened at 23.20. Every one of those is a price that is not the
// present arriving at a door that let it through.
//
// The rule above ("age, never magnitude") is still right, and it is why nothing here
// refuses a price for being far from another one: a halt resume, an opening gap and a
// news spike are all prices. What it missed is that a price can be far from the tape AND
// fresh, and that a slower door can serve a symbol the stream is actively printing.
//
//   5. THE CROSS-DOOR RULE. While Massive has printed this symbol inside
//      MASSIVE_ACTIVE_MS, a slower door (snapshot, Finnhub standby, Finnhub quote) may
//      only price it with a print no older than PREVAILING_MAX_AGE_MS. A 60 s-old standby
//      quote on a symbol the stream is writing is not the market; it is the market minus
//      whatever moved in that minute.
//
//   6. THE MAGNITUDE RULE — QUARANTINE, NEVER REFUSAL. A print more than
//      MAGNITUDE_JUMP_PCT away from the last price this gate ACCEPTED, inside
//      MAGNITUDE_WINDOW_MS, may value a position but may not close one. It becomes usable
//      when a second print agrees with it (within the same percentage), which is how a
//      genuine gap, halt resume or news spike clears — the second print confirms the new
//      level and the anchor moves to it. A symbol can therefore never freeze: one agreeing
//      print is all it takes, and the anchor only moves on a print the gate accepted.
//
// Neither rule sizes, prices or decides a trade. They answer "is this the present, on this
// symbol" — the question whose absence produced that morning's fills.
export const MASSIVE_ACTIVE_MS = 15000;
export const PREVAILING_MAX_AGE_MS = 10000;
export const MAGNITUDE_JUMP_PCT = 0.02;
export const MAGNITUDE_WINDOW_MS = 60000;

// symbol -> the latest execution time this gate has accepted. Ratchets forward only.
const lastExecution = new Map();

// symbol -> { price, atMs } of the last price this gate ACCEPTED (any door). A quarantined
// outlier never moves it, so a bad print cannot become the reference the next one is judged by.
const lastAccepted = new Map();

// symbol -> ms of the last ACCEPTED Massive stream print, so the cross-door rule knows which
// symbols the stream is actually writing.
const lastMassiveAt = new Map();

// symbol -> { price, atMs } of an outlier awaiting confirmation.
const pendingJump = new Map();

// Counted by tier, by source and by reason code, so a path that has started refusing
// everything is visible in the heartbeat instead of looking like a quiet market.
const gateCounts = { use: 0, quarantine: 0, refuse: 0, byCode: {}, bySource: {} };

// MONITORING OBSERVER (2026-11-10). A bystander, never a rule: when the worker sets one,
// it is handed every refused or quarantined verdict so the incident can be written to
// permanent history (priceIncidents.js). It is called synchronously, it may not await,
// and its failure is swallowed here — so a database outage can never change a verdict,
// a threshold, a price or an exit. An accepted price is not reported: there is nothing
// to investigate about a price the gate admitted.
let verdictObserver = null;

export function setVerdictObserver(fn) {
  verdictObserver = typeof fn === "function" ? fn : null;
}

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
    symbolsAccepted: lastAccepted.size,
    pendingJumps: pendingJump.size,
  };
}

// Test support only: forget every execution time and count this process has recorded.
export function resetGate() {
  lastExecution.clear();
  lastAccepted.clear();
  lastMassiveAt.clear();
  pendingJump.clear();
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
    const result = {
      tier,
      code,
      reason,
      source: src,
      symbol: sym,
      // The price and the provider's own stamp travel on the verdict so the monitoring
      // observer can record exactly what was refused. Nothing reads them to decide.
      price: Number.isFinite(Number(price)) ? Number(price) : null,
      printMs: Number(stampMs) > 0 ? Number(stampMs) : null,
      ...extra,
    };
    if (tier !== "use" && verdictObserver) {
      try {
        verdictObserver(result);
      } catch (_) {
        // An observer can never change a verdict.
      }
    }
    return result;
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

  // 5. THE CROSS-DOOR RULE. While the stream is printing this symbol, a slower door may not
  //    price it: a 60 s-old standby quote on a symbol the stream is writing is the market
  //    minus whatever moved in that minute, and it is what opened OMH 9 % from the book.
  const massiveAt = lastMassiveAt.get(sym) || 0;
  if (src !== "massive_stream" && nowMs - massiveAt <= MASSIVE_ACTIVE_MS && fresh.ageMs > PREVAILING_MAX_AGE_MS) {
    return verdict(
      "refuse",
      "lagging_door",
      `${src} price is ${(fresh.ageMs / 1000).toFixed(1)}s old while the stream is printing ${sym} (limit ${PREVAILING_MAX_AGE_MS / 1000}s)`,
      { ageMs: fresh.ageMs, massiveAgeMs: nowMs - massiveAt }
    );
  }

  // 6. THE MAGNITUDE RULE — quarantine, never refusal. A print far from the last ACCEPTED
  //    price may value a position but may not close one until a second print agrees with it.
  //    The anchor only moves on an accepted print, so an outlier cannot become the reference.
  const anchor = lastAccepted.get(sym);
  if (anchor && nowMs - anchor.atMs <= MAGNITUDE_WINDOW_MS) {
    const movePct = Math.abs(numeric - anchor.price) / anchor.price;
    if (movePct > MAGNITUDE_JUMP_PCT) {
      const pending = pendingJump.get(sym);
      const confirmed =
        pending &&
        nowMs - pending.atMs <= MAGNITUDE_WINDOW_MS &&
        Math.abs(numeric - pending.price) / pending.price <= MAGNITUDE_JUMP_PCT;
      if (!confirmed) {
        pendingJump.set(sym, { price: numeric, atMs: nowMs });
        return verdict(
          "quarantine",
          "magnitude_jump",
          `${numeric} is ${(movePct * 100).toFixed(1)}% from the last accepted ${anchor.price} — may value a position, may not close one until a second print agrees`,
          { movePct, anchorPrice: anchor.price }
        );
      }
    }
  }

  lastAccepted.set(sym, { price: numeric, atMs: nowMs });
  pendingJump.delete(sym);
  if (src === "massive_stream") lastMassiveAt.set(sym, nowMs);

  return verdict("use", null, null, { ageMs: fresh.ageMs, executionMs });
}