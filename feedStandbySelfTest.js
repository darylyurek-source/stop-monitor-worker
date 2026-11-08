// feedStandbySelfTest.js — the Finnhub standby, proven before the Massive switch.
//
//     node render-worker/feedStandbySelfTest.js
//
// Part 1 pins the gate: a Massive print makes Finnhub silent, 15 s of silence lets it
// through, the 60 s print-age and 3 % deviation guards reject a bad print, and Massive's
// next print closes the takeover.
//
// Part 2 replays a Massive dropout end to end and prints the timeline, so the takeover
// and the hand-back are visible rather than only asserted.
//
// Deterministic: every call is given its own time. No clock, no network, no socket.
// Exit code 0 = the standby may be used; exit code 1 = do not switch the feed.

import {
  admitFinnhub,
  noteMassive,
  summary,
  takeovers,
  reset,
  STALE_AFTER_MS,
  MAX_PRINT_AGE_MS,
  MAX_DEVIATION,
} from "./feedStandby.js";

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

const T0 = 1_000_000_000_000;

// ------------------------------------------------------------
// PART 1 — THE GATE
// ------------------------------------------------------------

reset();
noteMassive("AAPL", 100, T0);

check(
  "Finnhub silent while Massive is current",
  admitFinnhub("AAPL", 100.01, { now: T0 + 1000 }),
  { use: false, reason: "massive_current", massiveAgeMs: 1000 }
);

check(
  "exactly 15 s of Massive silence is still 'current'",
  admitFinnhub("AAPL", 100.01, { now: T0 + STALE_AFTER_MS }),
  { use: false, reason: "massive_current", massiveAgeMs: STALE_AFTER_MS }
);

check(
  "15 s + 1 ms lets Finnhub take the symbol over",
  admitFinnhub("AAPL", 100.02, { now: T0 + STALE_AFTER_MS + 1 }),
  { use: true, reason: "takeover", started: true, prints: 1, massiveAgeMs: STALE_AFTER_MS + 1 }
);

check(
  "a second standby print continues the same takeover",
  admitFinnhub("AAPL", 100.03, { now: T0 + STALE_AFTER_MS + 500 }),
  { use: true, reason: "takeover", started: false, prints: 2, massiveAgeMs: STALE_AFTER_MS + 500 }
);

const handback = noteMassive("AAPL", 100.10, T0 + STALE_AFTER_MS + 900);
check("Massive's next print hands the symbol back", handback?.symbol, "AAPL");
check("hand-back starts at the first standby print", handback?.startedAt, T0 + STALE_AFTER_MS + 1);
check("hand-back measures how long Finnhub served it", handback?.durationMs, 899);
check("hand-back counts the prints it carried", handback?.prints, 2);

check(
  "after the hand-back Finnhub is silent again",
  admitFinnhub("AAPL", 100.11, { now: T0 + STALE_AFTER_MS + 1000 }),
  { use: false, reason: "massive_current", massiveAgeMs: 100 }
);

// 60-second print-age guard, on a symbol Massive has gone quiet on.
reset();
noteMassive("MSFT", 50, T0);
check(
  "a standby print older than 60 s is refused",
  admitFinnhub("MSFT", 50.1, { now: T0 + STALE_AFTER_MS + 1000, exchangeMs: T0 + STALE_AFTER_MS + 1000 - MAX_PRINT_AGE_MS - 1 }),
  { use: false, reason: "stale_print", printAgeMs: MAX_PRINT_AGE_MS + 1, massiveAgeMs: STALE_AFTER_MS + 1000 }
);
check(
  "a standby print inside 60 s is used",
  admitFinnhub("MSFT", 50.1, { now: T0 + STALE_AFTER_MS + 1000, exchangeMs: T0 + STALE_AFTER_MS + 1000 - 5000 }),
  { use: true, reason: "takeover", started: true, prints: 1, massiveAgeMs: STALE_AFTER_MS + 1000 }
);

// 3 % deviation guard, against the last accepted price (here Massive's 50.00).
reset();
noteMassive("NVDA", 50, T0);
check(
  "a standby price more than 3 % away is refused",
  admitFinnhub("NVDA", 60, { now: T0 + STALE_AFTER_MS + 1 }),
  { use: false, reason: "deviation", deviation: 0.2, previous: 50, massiveAgeMs: STALE_AFTER_MS + 1 }
);
check(
  "a standby price inside 3 % is used",
  admitFinnhub("NVDA", 51.4, { now: T0 + STALE_AFTER_MS + 1 }),
  { use: true, reason: "takeover", started: true, prints: 1, massiveAgeMs: STALE_AFTER_MS + 1 }
);

check("deviation limit is 3 %", MAX_DEVIATION, 0.03);
check("summary counts the refused prints", summary(T0 + STALE_AFTER_MS + 2).dropped.deviation, 1);

// ------------------------------------------------------------
// PART 2 — SIMULATED MASSIVE DROPOUT
// ------------------------------------------------------------

console.log("\n— simulated Massive dropout on AAPL (clock driven, no network) —");
reset();

const B0 = 1_500_000_000_000;
const steps = [
  { at: B0 + 0, feed: "massive", price: 100.0 },
  { at: B0 + 3000, feed: "finnhub", price: 100.01 },
  { at: B0 + 9000, feed: "finnhub", price: 100.02 },
  { at: B0 + 16000, feed: "finnhub", price: 100.04 },
  { at: B0 + 19000, feed: "finnhub", price: 100.09 },
  { at: B0 + 21500, feed: "massive", price: 100.12 },
  { at: B0 + 22000, feed: "finnhub", price: 100.13 },
];

const clock = (ms) => new Date(ms).toISOString().slice(11, 23);

for (const step of steps) {
  if (step.feed === "massive") {
    const ended = noteMassive("AAPL", step.price, step.at);
    console.log(
      `${clock(step.at)}  massive  ${step.price.toFixed(2)}  ` +
      (ended
        ? `HANDED BACK — Finnhub served it ${(ended.durationMs / 1000).toFixed(1)}s (${ended.prints} prints)`
        : "primary feed")
    );
  } else {
    const verdict = admitFinnhub("AAPL", step.price, { now: step.at });
    console.log(
      `${clock(step.at)}  finnhub  ${step.price.toFixed(2)}  ` +
      (verdict.use
        ? verdict.started
          ? `STANDBY TAKEOVER — no Massive print for ${(verdict.massiveAgeMs / 1000).toFixed(1)}s`
          : `standby print ${verdict.prints}`
        : `dropped (${verdict.reason})`)
    );
  }
}

const sim = takeovers();
check("dropout produced exactly one takeover", sim.length, 1);
check("dropout takeover started after 15 s of silence", sim[0].startedAt, B0 + 16000);
check("dropout takeover handed back on Massive's next print", sim[0].endedAt, B0 + 21500);
check("dropout takeover lasted 5.5 s", sim[0].durationMs, 5500);
check("dropout takeover carried two standby prints", sim[0].prints, 2);

const finalSummary = summary(B0 + 22000);
console.log(
  `\nsummary: takeovers=${finalSummary.takeovers} active=${finalSummary.activeCount} ` +
  `finnhub_prints=${finalSummary.finnhubPrints} total=${(finalSummary.totalTakeoverMs / 1000).toFixed(1)}s ` +
  `longest=${(finalSummary.longestMs / 1000).toFixed(1)}s ` +
  `dropped=${JSON.stringify(finalSummary.dropped)}`
);

console.log(
  failures === 0
    ? `\n${cases} checks passed — the Finnish standby gate is ready for PRICE_FEED=massive`
    : `\n${failures} of ${cases} checks FAILED — do not switch the feed`
);

process.exit(failures === 0 ? 0 : 1);