// priceGateSelfTest.js — every price door, judged by one standard.
//
//     node render-worker/priceGateSelfTest.js
//
// The first cut guarded the Massive stream only. This pins the gate that now stands in front
// of ALL of them — stream, snapshot, Finnhub socket, Finnhub quote — against the day that
// proved it was needed, and against the two failures that are worse than a bad fill: refusing
// a genuine price, and admitting an unjudgeable one.
//
// Part 1 — 2026-11-09, replayed: the eight false fills are refused, the genuine prints beside
//          them are used, and the 120 s boundary is pinned exactly.
// Part 2 — freshness is AGE, never MAGNITUDE: a 20 % move is a price on every source.
// Part 3 — missing provenance can never be silently admitted, on any source.
// Part 4 — a re-publication is refused by the monotonic tape test even with no conditions.
// Part 5 — one symbol's refusal never touches another's.
// Part 6 — the counters the heartbeat reads actually move.
//
// Deterministic: every call is given its own clock. No clock, no network, no socket.
// Exit code 0 = the gate may stand in front of every door.

import {
  admitPrice,
  gateSummary,
  resetGate,
  SOURCE_LIMITS,
  REGRESSION_TOLERANCE_MS,
  MAX_EXECUTION_LAG_MS,
  FUTURE_TOLERANCE_MS,
} from "./tradeConditions.js";

let cases = 0;
let failures = 0;

function check(name, actual, expected) {
  cases += 1;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${name}` +
    (ok ? "" : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  );
}

// The verdict as the two things that matter: what it allowed, and why.
const tierCode = (v) => [v.tier, v.code];

// A fixed clock for the 2026-11-09 session, so nothing depends on when this runs.
const SESSION = Date.parse("2026-11-09T18:00:00Z");
const MIN = 60000;
const HOUR = 3600000;

const stream = (over) => admitPrice({ source: "massive_stream", nowMs: SESSION, ...over });

// ------------------------------------------------------------
// PART 1 — THE DAY, REPLAYED
// ------------------------------------------------------------
console.log("— Part 1: the 2026-11-09 fills, as frames —");
resetGate();

check(
  "WRBY 27.89 (never traded in the session) — extended hours, refused",
  tierCode(stream({ symbol: "WRBY", price: 27.89, stampMs: SESSION, conditions: [13], participantMs: SESSION - 1000 })),
  ["refuse", "extended_hours"]
);

check(
  "WRBY unlabelled but executed 5 h before it was taped — refused",
  tierCode(stream({ symbol: "WRBY2", price: 27.89, stampMs: SESSION, conditions: [], participantMs: SESSION - 5 * HOUR })),
  ["refuse", "late_print"]
);

check(
  "VSAT 69.79, executed 3.5 min before it was taped — refused",
  tierCode(stream({ symbol: "VSAT", price: 69.79, stampMs: SESSION, conditions: [32], participantMs: SESSION - 210000 })),
  ["refuse", "late_print"]
);

check(
  "SDGR 31.81, executed 3.9 min before it was taped — refused",
  tierCode(stream({ symbol: "SDGR", price: 31.81, stampMs: SESSION, conditions: [37], participantMs: SESSION - 236000 })),
  ["refuse", "late_print"]
);

check(
  "COHR 208.79, executed 5 h 29 m before it was taped — refused",
  tierCode(stream({ symbol: "COHR", price: 208.79, stampMs: SESSION, conditions: [32], participantMs: SESSION - (5 * HOUR + 29 * MIN) })),
  ["refuse", "late_print"]
);

check(
  "CENX 34.12 (the 14:51 flush) — refused",
  tierCode(stream({ symbol: "CENX", price: 34.12, stampMs: SESSION, conditions: [13], participantMs: SESSION - 5 * HOUR })),
  ["refuse", "extended_hours"]
);

check(
  "LASR 37.83 (price never traded in the session) — refused",
  tierCode(stream({ symbol: "LASR", price: 37.83, stampMs: SESSION, conditions: [13], participantMs: SESSION - 5 * HOUR })),
  ["refuse", "extended_hours"]
);

// THE CONTROLS. A gate that refuses these is as wrong as one that admits the fills above.
check(
  "EWTX, the genuine odd-lot exit (condition 37, 0 s lag) — USED",
  tierCode(stream({ symbol: "EWTX", price: 42.5, stampMs: SESSION, conditions: [37], participantMs: SESSION - 20 })),
  ["use", null]
);

check(
  "an in-session sweep (condition 14) — USED",
  tierCode(stream({ symbol: "SWEEP", price: 88.1, stampMs: SESSION, conditions: [14], participantMs: SESSION - 5 })),
  ["use", null]
);

check(
  "a regular sale reported late but in sequence (condition 32), 0 s lag — USED",
  tierCode(stream({ symbol: "LATE32", price: 55.2, stampMs: SESSION, conditions: [32], participantMs: SESSION - 30 })),
  ["use", null]
);

// The boundary, pinned: SDGR's ENTRY was the one genuinely borderline print of the day.
check(
  `a print executed ${(MAX_EXECUTION_LAG_MS - 1000) / 1000}s before it was taped — USED`,
  tierCode(stream({ symbol: "BND_IN", price: 31.57, stampMs: SESSION, conditions: [], participantMs: SESSION - (MAX_EXECUTION_LAG_MS - 1000) })),
  ["use", null]
);
check(
  `a print executed ${(MAX_EXECUTION_LAG_MS + 1000) / 1000}s before it was taped — REFUSED`,
  tierCode(stream({ symbol: "BND_OUT", price: 31.57, stampMs: SESSION, conditions: [], participantMs: SESSION - (MAX_EXECUTION_LAG_MS + 1000) })),
  ["refuse", "late_print"]
);

check(
  "extended-hours AND late AND regressed — the tape label is named first",
  tierCode(stream({ symbol: "PREC", price: 10, stampMs: SESSION, conditions: [13], participantMs: SESSION - 6 * HOUR })),
  ["refuse", "extended_hours"]
);

// ------------------------------------------------------------
// PART 2 — FRESHNESS IS AGE, NEVER MAGNITUDE
// ------------------------------------------------------------
console.log("\n— Part 2: a 20 % move is a price, on every source —");
resetGate();

for (const source of Object.keys(SOURCE_LIMITS)) {
  check(
    `${source}: a 20 % jump with a fresh stamp is USED (no % band exists)`,
    tierCode(admitPrice({
      source,
      symbol: `JUMP_${source}`,
      price: 120,
      stampMs: SESSION,
      nowMs: SESSION,
      participantMs: SESSION,
    })),
    ["use", null]
  );

  check(
    `${source}: one second past its own limit is REFUSED`,
    tierCode(admitPrice({
      source,
      symbol: `OLD_${source}`,
      price: 100,
      stampMs: SESSION - SOURCE_LIMITS[source] - 1000,
      nowMs: SESSION,
      participantMs: SESSION,
    })),
    ["refuse", "stale"]
  );
}

check(
  "a stamp further in the future than the tolerance is refused, not used",
  tierCode(admitPrice({
    source: "finnhub_stream",
    symbol: "FUTURE",
    price: 100,
    stampMs: SESSION + FUTURE_TOLERANCE_MS + 5000,
    nowMs: SESSION,
  })),
  ["refuse", "future"]
);

// ------------------------------------------------------------
// PART 3 — MISSING PROVENANCE IS NEVER SILENT
// ------------------------------------------------------------
console.log("\n— Part 3: no provenance, no silent pass —");
resetGate();

check(
  "stream print with NO pt and NO trft — QUARANTINED, never used",
  tierCode(stream({ symbol: "Q1", price: 50, stampMs: SESSION, conditions: [] })),
  ["quarantine", "no_execution_stamp"]
);

check(
  "the same print with conditions but still no execution stamp — QUARANTINED",
  tierCode(stream({ symbol: "Q2", price: 50, stampMs: SESSION, conditions: [37] })),
  ["quarantine", "no_execution_stamp"]
);

check(
  "the same print with a TRF receipt time — USED (it is provenanced)",
  tierCode(stream({ symbol: "Q3", price: 50, stampMs: SESSION, conditions: [], trfMs: SESSION - 40 })),
  ["use", null]
);

check(
  "Finnhub socket print with no stamp — REFUSED",
  tierCode(admitPrice({ source: "finnhub_stream", symbol: "F1", price: 50, stampMs: null, nowMs: SESSION })),
  ["refuse", "no_stamp"]
);

check(
  "Finnhub quote with no q.t — REFUSED",
  tierCode(admitPrice({ source: "finnhub_quote", symbol: "F2", price: 50, stampMs: null, nowMs: SESSION })),
  ["refuse", "no_stamp"]
);

check(
  "Massive snapshot with no lastTrade.t — REFUSED",
  tierCode(admitPrice({ source: "massive_snapshot", symbol: "S1", price: 50, stampMs: 0, nowMs: SESSION })),
  ["refuse", "no_stamp"]
);

check(
  "a snapshot carrying an extended-hours condition — REFUSED",
  tierCode(admitPrice({ source: "massive_snapshot", symbol: "S2", price: 27.89, stampMs: SESSION, nowMs: SESSION, conditions: [13] })),
  ["refuse", "extended_hours"]
);

// The invariant, exhaustively: no combination of missing provenance may reach 'use'.
let everUsed = false;
for (const conditions of [[], [37]]) {
  for (const trfMs of [null, 0]) {
    const v = stream({ symbol: `INV_${conditions.length}_${trfMs}`, price: 50, stampMs: SESSION, conditions, trfMs });
    if (v.tier === "use") everUsed = true;
  }
}
check("no unprovenanced stream print can reach 'use'", everUsed, false);

// ------------------------------------------------------------
// PART 4 — THE MONOTONIC TAPE
// ------------------------------------------------------------
console.log("\n— Part 4: a late re-publication is refused with no conditions at all —");
resetGate();

check(
  "first print of the day sets the tape",
  tierCode(admitPrice({ source: "finnhub_stream", symbol: "RG", price: 100, stampMs: SESSION - 1000, nowMs: SESSION })),
  ["use", null]
);

check(
  "a fresh-looking print executed 4 s further back — REFUSED as regressed",
  tierCode(admitPrice({ source: "massive_stream", symbol: "RG", price: 99.9, stampMs: SESSION, nowMs: SESSION, participantMs: SESSION - 5000 })),
  ["refuse", "regressed"]
);

check(
  `a print ${REGRESSION_TOLERANCE_MS - 500}ms back is still in order — USED`,
  tierCode(admitPrice({ source: "massive_stream", symbol: "RG", price: 100.1, stampMs: SESSION, nowMs: SESSION, participantMs: SESSION - (REGRESSION_TOLERANCE_MS - 500) })),
  ["use", null]
);

// ------------------------------------------------------------
// PART 5 — ONE SYMBOL CANNOT AFFECT ANOTHER
// ------------------------------------------------------------
console.log("\n— Part 5: refusals do not spread —");
resetGate();

stream({ symbol: "BAD", price: 10, stampMs: SESSION, conditions: [13], participantMs: SESSION - 1000 });
stream({ symbol: "BAD", price: 10, stampMs: SESSION, conditions: [13], participantMs: SESSION - 1000 });
stream({ symbol: "BAD", price: 10, stampMs: SESSION, conditions: [13], participantMs: SESSION - 1000 });

check(
  "a symbol refused three times still admits a clean print",
  tierCode(stream({ symbol: "BAD", price: 10.5, stampMs: SESSION, conditions: [37], participantMs: SESSION - 10 })),
  ["use", null]
);
check(
  "an unrelated symbol is untouched by those refusals",
  tierCode(stream({ symbol: "GOOD", price: 20, stampMs: SESSION, conditions: [], participantMs: SESSION - 10 })),
  ["use", null]
);

// ------------------------------------------------------------
// PART 6 — UNKNOWN DOORS, BAD PRICES, AND THE COUNTERS
// ------------------------------------------------------------
console.log("\n— Part 6: unknown source, bad price, counters —");
resetGate();

check("an unknown source is refused, not defaulted", tierCode(admitPrice({ source: "carrier_pigeon", symbol: "X", price: 1, stampMs: SESSION, nowMs: SESSION })), ["refuse", "unknown_source"]);
check("a zero price is refused", tierCode(admitPrice({ source: "finnhub_quote", symbol: "X1", price: 0, stampMs: SESSION, nowMs: SESSION })), ["refuse", "bad_price"]);
check("a non-numeric price is refused", tierCode(admitPrice({ source: "finnhub_quote", symbol: "X2", price: "abc", stampMs: SESSION, nowMs: SESSION })), ["refuse", "bad_price"]);

resetGate();
stream({ symbol: "CNT", price: 10, stampMs: SESSION, conditions: [13], participantMs: SESSION - 1000 });
const summary = gateSummary();
check("the heartbeat sees the refusal", summary.refuse, 1);
check("and knows why", summary.byCode.extended_hours, 1);
check("and from which door", summary.bySource.massive_stream.refuse, 1);

console.log(
  failures === 0
    ? `\n${cases} checks passed — one gate stands in front of every price source`
    : `\n${failures} of ${cases} checks FAILED — the gate is not ready for every source`
);

process.exit(failures === 0 ? 0 : 1);