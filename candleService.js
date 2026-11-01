// candleService.js — the worker's own 1-minute series.
//
// The Vector scores the bar that is STILL FORMING, so a series that only holds
// completed bars cannot reproduce a live score (this is the same limitation that
// made archive replay inexact). The worker therefore keeps its own bars, built
// from the ticks it already receives:
//
//   seed()      once per symbol per session — the completed bars from the archive
//   applyTick() on every price — updates the forming bar in place, or opens a new
//               one at the minute boundary with the previous close as its open
//
// A bar's `t` is its minute start, its high/low/close move with the price, and its
// volume stays 0 because the tick stream carries no size. Volume is one of the
// seven Vector components; with no size it contributes its neutral value, exactly
// as Base44's own series does when the provider returns zero volume.
//
// No I/O happens per tick. Seeding is the only network call, and it is bounded
// and de-duplicated so a burst of ticks cannot trigger a burst of fetches.

import { listCandles } from "./bridge.js";

const sessions = new Map(); // symbol -> { date, bars: [] }
const seeding = new Map(); // symbol -> Promise (in-flight seed)

const dateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function etDate(ms = Date.now()) {
  return dateFmt.format(new Date(ms));
}

export const minuteStart = (ms) => Math.floor(ms / 60000) * 60000;

function toBar(row) {
  const t = Number(row?.candle_epoch) || Date.parse(row?.candle_time);
  const close = Number(row?.close);
  if (!Number.isFinite(t) || !Number.isFinite(close) || close <= 0) return null;
  return {
    t: minuteStart(t),
    open: Number.isFinite(Number(row?.open)) ? Number(row.open) : close,
    high: Number.isFinite(Number(row?.high)) ? Number(row.high) : close,
    low: Number.isFinite(Number(row?.low)) ? Number(row.low) : close,
    close,
    volume: Number.isFinite(Number(row?.volume)) ? Number(row.volume) : 0,
  };
}

// Load the session's completed bars for one symbol. Idempotent and de-duplicated:
// concurrent callers share one fetch, and a symbol already seeded for today is not
// fetched again.
export async function seed(symbol, date = etDate()) {
  const existing = sessions.get(symbol);
  if (existing && existing.date === date && existing.bars.length > 0) return existing.bars.length;

  if (seeding.has(symbol)) return seeding.get(symbol);

  const task = (async () => {
    let rows = [];
    try {
      rows = await listCandles(symbol, date);
    } catch (_) {
      rows = []; // an unseeded symbol still runs: price-only rules never need candles
    }
    const bars = rows.map(toBar).filter(Boolean).sort((a, b) => a.t - b.t);
    const current = sessions.get(symbol);
    if (current && current.date === date) {
      // Keep bars built from ticks that are newer than the archived tail.
      const lastArchived = bars.length ? bars[bars.length - 1].t : 0;
      for (const b of current.bars) if (b.t > lastArchived) bars.push(b);
    }
    sessions.set(symbol, { date, bars });
    return bars.length;
  })().finally(() => seeding.delete(symbol));

  seeding.set(symbol, task);
  return task;
}

// Apply one price to the series and return it. Never awaits, never fetches.
export function applyTick(symbol, price, atMs = Date.now()) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return bars(symbol);

  const date = etDate(atMs);
  let session = sessions.get(symbol);
  if (!session || session.date !== date) {
    session = { date, bars: [] };
    sessions.set(symbol, session);
  }

  const bucket = minuteStart(atMs);
  const list = session.bars;
  const last = list[list.length - 1];

  if (last && last.t === bucket) {
    last.high = Math.max(last.high, p);
    last.low = Math.min(last.low, p);
    last.close = p;
  } else {
    const open = last ? last.close : p;
    list.push({ t: bucket, open, high: Math.max(open, p), low: Math.min(open, p), close: p, volume: 0 });
  }
  return list;
}

export function bars(symbol) {
  return sessions.get(symbol)?.bars || null;
}

export function barCount(symbol) {
  return sessions.get(symbol)?.bars.length || 0;
}

export function isSeeded(symbol, date = etDate()) {
  const s = sessions.get(symbol);
  return Boolean(s && s.date === date && s.bars.length > 0);
}

// Drop yesterday's series at the start of a new session.
export function resetStale(date = etDate()) {
  for (const [symbol, s] of sessions) if (s.date !== date) sessions.delete(symbol);
}