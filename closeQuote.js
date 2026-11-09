// closeQuote.js — the price the 16:00 close is executed at.
//
// WHY THIS EXISTS (2026-11-09). The session sweep originally closed at "the last price this
// process holds for the symbol". That is only a valid price if it is RECENT: a symbol that
// stopped printing an hour earlier — a halt, a feed gap, a dropped subscription — would have
// been closed at an hour-old price, and the ledger would carry a fill that never existed in the
// market at the close. That is a false simulated execution, and it is the one thing a paper
// ledger must never record.
//
// So the sweep now ASKS for a price at the moment it closes, in this order:
//
//   1. this process's own last accepted price — but only if it is inside CLOSE_MAX_PRICE_AGE_MS
//   2. Massive's snapshot for the symbol (its own last trade, already age-checked to 60 s there)
//   3. a Finnhub quote, if the quote itself is current
//   4. ONLY IF NOTHING CURRENT EXISTS: the most recent price that does exist, returned with
//      fresh: false and its age, because leaving a position open past the close is worse than
//      closing it at the last price that actually traded
//
// A halted symbol legitimately has no current market price — its last print IS the market —
// so case 4 is a real case, not a failure. It is LABELLED, never silent: the sweep logs it and
// counts it.
//
// It chooses a price by RECENCY, never by size: no band, no threshold, no rejection for being
// far from another price. The price is exactly what a tick would have carried, and decideTick
// still decides — no rule, size, fee or exit level is computed here.

export const CLOSE_MAX_PRICE_AGE_MS = 60000; // a price must describe the market as of the close

function usable(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// The worker's held price as { price, at }. Accepts a bare number (no age known) so an older
// caller cannot silently lose the price.
function normaliseHeld(heldPrice) {
  if (heldPrice == null) return null;
  if (typeof heldPrice === "number") {
    const price = usable(heldPrice);
    return price ? { price, at: null } : null;
  }
  const price = usable(heldPrice.price);
  if (!price) return null;
  const at = Number(heldPrice.at);
  return { price, at: Number.isFinite(at) && at > 0 ? at : null };
}

// Both fetchers return a price (snapshot) or { price, at } (quote), or null. Neither is allowed
// to break the close: a provider outage falls through to the next source.
async function askSnapshot(fetchSnapshot, symbol) {
  if (typeof fetchSnapshot !== "function") return null;
  try {
    return usable(await fetchSnapshot(symbol));
  } catch (_) {
    return null;
  }
}

async function askQuote(fetchQuote, symbol) {
  if (typeof fetchQuote !== "function") return null;
  try {
    const raw = await fetchQuote(symbol);
    if (raw == null) return null;
    if (typeof raw === "number") {
      const price = usable(raw);
      return price ? { price, at: null } : null;
    }
    const price = usable(raw.price);
    if (!price) return null;
    const at = Number(raw.at);
    return { price, at: Number.isFinite(at) && at > 0 ? at : null };
  } catch (_) {
    return null;
  }
}

// A Finnhub quote WITH the provider's own stamp, so the caller can judge its age.
// Policy-free on purpose: it accepts and rejects nothing — resolveClosePrice decides whether the
// quote is current, exactly as the standby gate decides for a tick.
export async function finnhubQuote(symbol, apiKey, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  if (!apiKey) return null;
  try {
    const res = await fetchImpl(
      `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${apiKey}`,
      { signal: AbortSignal.timeout(timeoutMs) }
    );
    if (!res.ok) return null;
    const q = await res.json().catch(() => null);
    const price = Number(q && q.c);
    if (!Number.isFinite(price) || price <= 0) return null;
    const ts = Number(q && q.t);
    return { price, at: Number.isFinite(ts) && ts > 0 ? ts * 1000 : null };
  } catch (_) {
    return null;
  }
}

// Build the resolver the sweep calls, from the router's own maps. The maps are PASSED IN, never
// imported, so the policy stays testable without a socket or a database.
export function makeClosePriceResolver({
  lastPrice,
  lastTick,
  fetchSnapshot = null,
  fetchQuote = null,
  now = Date.now,
  maxAgeMs,
} = {}) {
  return (position) => {
    const symbol = String(position?.symbol || "").toUpperCase();
    const price = Number(lastPrice?.get?.(symbol));
    const at = Number(lastTick?.get?.(symbol));
    const heldPrice =
      Number.isFinite(price) && price > 0
        ? { price, at: Number.isFinite(at) && at > 0 ? at : null }
        : null;
    return resolveClosePrice({
      symbol,
      position,
      heldPrice,
      fetchSnapshot,
      fetchQuote,
      now: typeof now === "function" ? now() : now,
      ...(Number(maxAgeMs) > 0 ? { maxAgeMs: Number(maxAgeMs) } : {}),
    });
  };
}

export function ageText(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs < 0) return "age unknown";
  const secs = Math.round(ageMs / 1000);
  if (secs < 120) return `${secs}s old`;
  return `${Math.round(secs / 60)}min old`;
}

//   symbol        — the position's symbol
//   position      — the position record (its current_price is the last resort)
//   heldPrice     — { price, at } from the router, or null
//   fetchSnapshot — async (symbol) => price | null   (Massive, self-age-checked)
//   fetchQuote    — async (symbol) => { price, at } | null  (Finnhub)
//
// Returns { price, basis, ageMs, fresh } or null when no price of any kind exists — in which
// case the sweep writes nothing and tries again, rather than inventing a fill.
export async function resolveClosePrice({
  symbol,
  position = null,
  heldPrice = null,
  fetchSnapshot = null,
  fetchQuote = null,
  now = Date.now(),
  maxAgeMs = CLOSE_MAX_PRICE_AGE_MS,
} = {}) {
  const sym = String(symbol || position?.symbol || "").toUpperCase();
  const nowMs = Number(now) || Date.now();
  const limit = Number(maxAgeMs) > 0 ? Number(maxAgeMs) : CLOSE_MAX_PRICE_AGE_MS;

  // 1. Our own price, if it still describes the market.
  const held = normaliseHeld(heldPrice);
  if (held && Number.isFinite(held.at) && nowMs - held.at <= limit) {
    return { price: held.price, basis: "last accepted price", ageMs: nowMs - held.at, fresh: true };
  }

  // 2. Ask the market. This is the fix: at the close the price is FETCHED, not remembered.
  const snapshot = await askSnapshot(fetchSnapshot, sym);
  if (snapshot) {
    return { price: snapshot, basis: "Massive snapshot taken at the close", ageMs: null, fresh: true };
  }

  // 3. Finnhub's quote, if the quote itself is current.
  const quote = await askQuote(fetchQuote, sym);
  if (quote && (!Number.isFinite(quote.at) || nowMs - quote.at <= limit)) {
    return {
      price: quote.price,
      basis: "Finnhub quote taken at the close",
      ageMs: Number.isFinite(quote.at) ? nowMs - quote.at : null,
      fresh: true,
    };
  }

  // 4. Nothing current. Close at the most recent price that exists, labelled with its age.
  const stale = [];
  if (held) {
    stale.push({ price: held.price, basis: "last accepted price", ageMs: Number.isFinite(held.at) ? nowMs - held.at : null });
  }
  if (quote) {
    stale.push({ price: quote.price, basis: "Finnhub quote", ageMs: Number.isFinite(quote.at) ? nowMs - quote.at : null });
  }
  const stored = usable(position?.current_price);
  if (stored) stale.push({ price: stored, basis: "position's stored price", ageMs: null });

  if (!stale.length) return null;

  stale.sort((a, b) => (a.ageMs ?? Infinity) - (b.ageMs ?? Infinity));
  const pick = stale[0];
  return { ...pick, fresh: false, reason: "no current price available at the close" };
}