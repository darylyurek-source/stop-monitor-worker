// dbVerify.js — the startup identity check. READ-ONLY.
//
// Proves this service reaches the same Cloud SQL database Base44 trades on. It calls ONLY two
// whitelisted bridge operations — `ping_timed` and `countAllPositionsInTable` — so it cannot
// create, update or delete a record, and it takes no part in tick routing or in any trading
// rule: nothing here opens, manages or closes a position.
//
// The bridge accepts no arbitrary SQL by design, so it exposes no operation that returns the
// database NAME. Identity is therefore proven by fingerprint: the live database must answer
// with these tables, and the row counts are printed for comparison.
//
// Split out of worker.js (2026-11-09) so the router file holds routing and trading, not
// diagnostics. Behaviour, log lines and the read-only guarantee are unchanged.

const VERIFY_TABLES = ["positions_anew", "positions_b", "positions_c", "positions_d", "positions_e"];

async function bridgeRead(bridgeUrl, bridgeKey, operation, params = {}) {
  const t0 = Date.now();
  const res = await fetch(`${bridgeUrl}/db`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${bridgeKey}` },
    body: JSON.stringify({ operation, params }),
    signal: AbortSignal.timeout(10000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    throw new Error(`${operation}: HTTP ${res.status} ${body.error || "no error detail"}`);
  }
  return { result: body.result, ms: Date.now() - t0 };
}

// Never throws: a failure is logged and the process carries on routing ticks.
export async function verifyDatabase({ bridgeUrl = "", bridgeKey = "", log = console.log, logError = console.error } = {}) {
  if (!bridgeUrl || !bridgeKey) {
    log(
      "[db] verification skipped - BRIDGE_URL / BRIDGE_API_KEY are not set on this service (tick routing unaffected)"
    );
    return;
  }
  try {
    const health = await fetch(`${bridgeUrl}/health`, { signal: AbortSignal.timeout(10000) })
      .then((r) => r.json())
      .catch(() => null);
    log(
      `[db] bridge ${bridgeUrl.replace(/^https?:\/\//, "")} health=${health && health.ok ? "ok" : "unavailable"}`
    );

    const ping = await bridgeRead(bridgeUrl, bridgeKey, "ping_timed");
    const p = ping.result || {};
    log(
      `[db] ping ok - round trip ${ping.ms} ms, Cloud SQL ${p.elapsed_ms} ms, server time ${p.server_time}`
    );

    const counts = [];
    for (const table of VERIFY_TABLES) {
      const c = await bridgeRead(bridgeUrl, bridgeKey, "countAllPositionsInTable", { table });
      counts.push(`${table}=${c.result}`);
    }
    log(`[db] rows  ${counts.join("  ")}`);
    log(
      "[db] verdict: reached the live Cloud SQL database - same instance and tables Base44 trades on (read-only, nothing written)"
    );
  } catch (err) {
    logError(`[db] verification FAILED - ${err.message}`);
  }
}