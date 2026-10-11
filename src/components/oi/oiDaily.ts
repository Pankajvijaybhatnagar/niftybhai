import { useEffect, useState } from "react";
import type { OIRow, OISnapshot, OISource, PackedSnapshot } from "./oiData";
import { chainTotals, pack, parseSourceId, trimAroundSpot, unpack } from "./oiData";

// =========================
// Time ranges. 1H / 1D come from this browser's live snapshots (today).
// 1W / 1M come from NSE's end-of-day bhavcopy - one point per trading day -
// with today's latest live update as the final point.
// =========================
export type TimeRange = "1H" | "1D" | "1W" | "1M";
export const TIME_RANGES: TimeRange[] = ["1H", "1D", "1W", "1M"];

export const isDailyRange = (range: TimeRange) => range === "1W" || range === "1M";
export const rangeDays = (range: TimeRange) => (range === "1M" ? 30 : 7);

const DAY_MS = 86_400_000;
const STORAGE_PREFIX = "oi-daily:v1:";
const KEEP_DAYS = 45;
const NONE = "none";

const dateKey = (t: number) => new Date(t).toLocaleDateString("en-CA");

/** Weekdays from `days` calendar days ago up to today, oldest first. */
function weekdays(days: number): string[] {
    const out: string[] = [];
    const now = new Date();
    for (let i = days; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(now.getDate() - i);
        if (d.getDay() !== 0 && d.getDay() !== 6) out.push(dateKey(d.getTime()));
    }
    return out;
}

let purged = false;
function purgeOld() {
    if (purged) return;
    purged = true;
    try {
        const oldest = dateKey(Date.now() - KEEP_DAYS * DAY_MS);
        for (let i = localStorage.length - 1; i >= 0; i--) {
            const key = localStorage.key(i);
            if (!key?.startsWith(STORAGE_PREFIX)) continue;
            const date = key.slice(-10);
            if (date < oldest) localStorage.removeItem(key);
        }
    } catch {
        // storage unavailable
    }
}

const memory = new Map<string, OISnapshot | null>();
const inFlight = new Map<string, Promise<OISnapshot | null>>();

function readStored(key: string): OISnapshot | null | undefined {
    try {
        const raw = localStorage.getItem(key);
        if (raw === null) return undefined;
        if (raw === NONE) return null;
        return unpack(JSON.parse(raw) as PackedSnapshot);
    } catch {
        return undefined;
    }
}

function store(key: string, snap: OISnapshot | null) {
    try {
        localStorage.setItem(key, snap ? JSON.stringify(pack(snap)) : NONE);
    } catch {
        // quota - it will just be fetched again next time
    }
}

async function fetchDay(symbol: string, expiry: string, date: string): Promise<OISnapshot | null> {
    const key = `${STORAGE_PREFIX}${symbol}|${expiry}|${date}`;
    if (memory.has(key)) return memory.get(key) ?? null;

    const stored = readStored(key);
    if (stored !== undefined) {
        memory.set(key, stored);
        return stored;
    }

    const pending = inFlight.get(key);
    if (pending) return pending;

    const request = (async () => {
        const query = new URLSearchParams({ symbol, expiry, date });
        const response = await fetch(`/api/oi-history?${query}`);

        // today's / yesterday's file may simply not be published yet, so only
        // remember "no data" for older dates (holidays)
        const settled = date < dateKey(Date.now() - DAY_MS);

        if (response.status === 404) {
            if (settled) store(key, null);
            memory.set(key, null);
            return null;
        }
        if (!response.ok) throw new Error(`Daily OI request failed (${response.status})`);

        const body = (await response.json()) as { spot: number; rows: OIRow[] };
        if (!body.rows?.length) {
            if (settled) store(key, null);
            memory.set(key, null);
            return null;
        }

        const close = new Date(`${date}T15:30:00`).getTime();
        const snap: OISnapshot = {
            t: close,
            spot: body.spot,
            totals: chainTotals(body.rows),
            rows: trimAroundSpot(body.rows, body.spot),
        };
        store(key, snap);
        memory.set(key, snap);
        return snap;
    })();

    inFlight.set(key, request);
    try {
        return await request;
    } finally {
        inFlight.delete(key);
    }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const i = next++;
            out[i] = await fn(items[i]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return out;
}

interface DailyState {
    key: string;
    snapshots: OISnapshot[];
    error: string | null;
}

export interface DailyHistory {
    snapshots: OISnapshot[];
    loading: boolean;
    error: string | null;
}

/** End-of-day snapshots for the last `days` calendar days (only fetched when enabled). */
export function useDailyHistory(source: OISource | null, days: number, enabled: boolean): DailyHistory {
    const parsed = source ? parseSourceId(source.id) : null;
    const key = enabled && parsed ? `${parsed.symbol}|${parsed.expiry}|${days}` : "";
    const [state, setState] = useState<DailyState>({ key: "", snapshots: [], error: null });

    useEffect(() => {
        if (!key) return;
        purgeOld();

        const [symbol, expiry] = key.split("|");
        let cancelled = false;
        let failure: string | null = null;

        mapLimit(weekdays(days), 4, (date) =>
            fetchDay(symbol, expiry, date).catch((e: unknown) => {
                failure = e instanceof Error ? e.message : String(e);
                return null;
            })
        ).then((results) => {
            if (cancelled) return;
            setState({
                key,
                snapshots: results.filter((s): s is OISnapshot => s !== null),
                error: failure,
            });
        });

        return () => {
            cancelled = true;
        };
    }, [key, days]);

    const current = state.key === key;
    return {
        snapshots: current ? state.snapshots : [],
        loading: Boolean(key) && !current,
        error: current ? state.error : null,
    };
}

/** The snapshots a chart should plot for a range. */
export function seriesForRange(range: TimeRange, intraday: OISnapshot[], daily: OISnapshot[]): OISnapshot[] {
    const last = intraday[intraday.length - 1];

    if (range === "1H") return last ? intraday.filter((s) => s.t >= last.t - 3_600_000) : [];
    if (range === "1D") return intraday;

    const cutoff = Date.now() - rangeDays(range) * DAY_MS;
    const points = daily.filter((s) => s.t >= cutoff);
    if (last) {
        // today's live update is the newest point (replacing today's close if both exist).
        // On a weekend / holiday the live chain just repeats the last close - skip it.
        const lastDaily = points[points.length - 1];
        const unchanged =
            lastDaily &&
            lastDaily.totals.ceOI === last.totals.ceOI &&
            lastDaily.totals.peOI === last.totals.peOI;
        if (lastDaily && dateKey(lastDaily.t) === dateKey(last.t)) points[points.length - 1] = last;
        else if (!unchanged) points.push(last);
    }
    return points;
}
