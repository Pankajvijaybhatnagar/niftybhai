import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { OptionChainRow } from "../../types/optionChain";

// =========================
// Normalised shape every OI chart works from - one row per strike.
// =========================
export interface OIRow {
    strike: number;
    ceOI: number;
    peOI: number;
    ceChg: number;
    peChg: number;
    ceVol: number;
    peVol: number;
    ceLTP: number;
    peLTP: number;
}

// Full-chain totals, kept separately because snapshots only store strikes near spot.
export interface OITotals {
    ceOI: number;
    peOI: number;
    ceChg: number;
    peChg: number;
}

export interface OISource {
    id: string; // instrument + expiry, so histories never mix
    spot: number;
    rows: OIRow[];
}

export interface OISnapshot {
    t: number;
    spot: number;
    totals: OITotals;
    rows: OIRow[]; // sorted by strike, trimmed around spot
}

const num = (v: unknown) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
};

export function fromNseRows(rows: OptionChainRow[]): OISource | null {
    if (!rows?.length) return null;

    const first = rows.find((r) => r.CE || r.PE);
    const leg = (first?.CE ?? first?.PE) as Record<string, unknown> | undefined;
    if (!first || !leg) return null;

    const spot = num(leg.underlyingValue);
    const underlying = String(leg.underlying ?? "NSE");
    const expiry = String(first.expiryDate ?? leg.expiryDate ?? "");

    const out: OIRow[] = rows.map((row) => {
        const ce = (row.CE ?? {}) as Record<string, unknown>;
        const pe = (row.PE ?? {}) as Record<string, unknown>;
        return {
            strike: num(row.strikePrice),
            ceOI: num(ce.openInterest),
            peOI: num(pe.openInterest),
            ceChg: num(ce.changeinOpenInterest),
            peChg: num(pe.changeinOpenInterest),
            ceVol: num(ce.totalTradedVolume),
            peVol: num(pe.totalTradedVolume),
            ceLTP: num(ce.lastPrice),
            peLTP: num(pe.lastPrice),
        };
    });

    return { id: `NSE|${underlying}|${expiry}`, spot, rows: out };
}

// =========================
// Session history store. Every distinct live update becomes a snapshot, kept
// per instrument for the current day in localStorage, so rate-of-change and
// big-player detection survive a page refresh.
// =========================
const MAX_SNAPSHOTS = 900;
const STRIKES_EACH_SIDE = 25;
const SAVE_EVERY_MS = 10_000;
const STORAGE_PREFIX = "oi-history:v1:";
const FIELDS = 9;

const EMPTY: OISnapshot[] = [];
const cache = new Map<string, OISnapshot[]>();
const listeners = new Map<string, Set<() => void>>();
const lastSaved = new Map<string, number>();

const today = () => new Date().toLocaleDateString("en-CA");
const storageKey = (id: string) => `${STORAGE_PREFIX}${today()}:${id}`;

export interface PackedSnapshot {
    t: number;
    s: number;
    tot: number[];
    d: number[];
}

export const pack = (snap: OISnapshot): PackedSnapshot => ({
    t: snap.t,
    s: snap.spot,
    tot: [snap.totals.ceOI, snap.totals.peOI, snap.totals.ceChg, snap.totals.peChg],
    d: snap.rows.flatMap((r) => [
        r.strike, r.ceOI, r.peOI, r.ceChg, r.peChg, r.ceVol, r.peVol, r.ceLTP, r.peLTP,
    ]),
});

export const unpack = (p: PackedSnapshot): OISnapshot => {
    const rows: OIRow[] = [];
    for (let i = 0; i + FIELDS <= p.d.length; i += FIELDS) {
        const d = p.d;
        rows.push({
            strike: d[i], ceOI: d[i + 1], peOI: d[i + 2], ceChg: d[i + 3], peChg: d[i + 4],
            ceVol: d[i + 5], peVol: d[i + 6], ceLTP: d[i + 7], peLTP: d[i + 8],
        });
    }
    return {
        t: p.t,
        spot: p.s,
        totals: { ceOI: p.tot[0], peOI: p.tot[1], ceChg: p.tot[2], peChg: p.tot[3] },
        rows,
    };
};

let purged = false;
function purgeOtherDays() {
    if (purged) return;
    purged = true;
    try {
        const prefixToday = `${STORAGE_PREFIX}${today()}:`;
        for (let i = localStorage.length - 1; i >= 0; i--) {
            const key = localStorage.key(i);
            if (key?.startsWith(STORAGE_PREFIX) && !key.startsWith(prefixToday)) {
                localStorage.removeItem(key);
            }
        }
    } catch {
        // storage unavailable - history just stays in memory
    }
}

function load(id: string): OISnapshot[] {
    purgeOtherDays();
    try {
        const raw = localStorage.getItem(storageKey(id));
        if (!raw) return [];
        const parsed = JSON.parse(raw) as PackedSnapshot[];
        return Array.isArray(parsed) ? parsed.map(unpack) : [];
    } catch {
        return [];
    }
}

function save(id: string, snaps: OISnapshot[]) {
    lastSaved.set(id, Date.now());
    try {
        localStorage.setItem(storageKey(id), JSON.stringify(snaps.map(pack)));
    } catch {
        // quota hit - keep the newer half
        try {
            const half = snaps.slice(Math.floor(snaps.length / 2));
            localStorage.setItem(storageKey(id), JSON.stringify(half.map(pack)));
        } catch {
            // ignore
        }
    }
}

if (typeof window !== "undefined") {
    window.addEventListener("pagehide", () => {
        cache.forEach((snaps, id) => save(id, snaps));
    });
}

export function getHistory(id: string): OISnapshot[] {
    if (!id) return EMPTY;
    let snaps = cache.get(id);
    if (!snaps) {
        snaps = load(id);
        cache.set(id, snaps);
    }
    return snaps;
}

function subscribe(id: string, fn: () => void) {
    let set = listeners.get(id);
    if (!set) {
        set = new Set();
        listeners.set(id, set);
    }
    set.add(fn);
    return () => {
        set.delete(fn);
    };
}

export function trimAroundSpot(rows: OIRow[], spot: number): OIRow[] {
    const sorted = [...rows].sort((a, b) => a.strike - b.strike);
    let atm = 0;
    sorted.forEach((r, i) => {
        if (Math.abs(r.strike - spot) < Math.abs(sorted[atm].strike - spot)) atm = i;
    });
    return sorted.slice(Math.max(0, atm - STRIKES_EACH_SIDE), atm + STRIKES_EACH_SIDE + 1);
}

const signature = (spot: number, rows: OIRow[]) =>
    rows.reduce((s, r) => s + r.ceOI * 3 + r.peOI * 7 + r.ceVol + r.peVol * 5, 0) + spot;

export function recordSnapshot(src: OISource) {
    if (!src.rows.length || src.spot <= 0) return;

    const prev = getHistory(src.id);
    const last = prev[prev.length - 1];

    // a response from a different instrument would show up as a big spot jump
    if (last && Math.abs(src.spot - last.spot) / last.spot > 0.1) return;

    const rows = trimAroundSpot(src.rows, src.spot);
    if (last && signature(last.spot, last.rows) === signature(src.spot, rows)) return;

    const totals = src.rows.reduce<OITotals>(
        (acc, r) => ({
            ceOI: acc.ceOI + r.ceOI,
            peOI: acc.peOI + r.peOI,
            ceChg: acc.ceChg + r.ceChg,
            peChg: acc.peChg + r.peChg,
        }),
        { ceOI: 0, peOI: 0, ceChg: 0, peChg: 0 }
    );

    const next = [...prev, { t: Date.now(), spot: src.spot, totals, rows }].slice(-MAX_SNAPSHOTS);
    cache.set(src.id, next);
    listeners.get(src.id)?.forEach((fn) => fn());

    if (Date.now() - (lastSaved.get(src.id) ?? 0) > SAVE_EVERY_MS) save(src.id, next);
}

export function clearHistory(id: string) {
    cache.set(id, []);
    try {
        localStorage.removeItem(storageKey(id));
    } catch {
        // ignore
    }
    listeners.get(id)?.forEach((fn) => fn());
}

export function useOIHistory(source: OISource | null): OISnapshot[] {
    const id = source?.id ?? "";

    useEffect(() => {
        if (source) recordSnapshot(source);
    }, [source]);

    const sub = useCallback((fn: () => void) => subscribe(id, fn), [id]);
    const get = useCallback(() => getHistory(id), [id]);

    return useSyncExternalStore(sub, get);
}

export function chainTotals(rows: OIRow[]): OITotals {
    return rows.reduce<OITotals>(
        (acc, r) => ({
            ceOI: acc.ceOI + r.ceOI,
            peOI: acc.peOI + r.peOI,
            ceChg: acc.ceChg + r.ceChg,
            peChg: acc.peChg + r.peChg,
        }),
        { ceOI: 0, peOI: 0, ceChg: 0, peChg: 0 }
    );
}

/** "NSE|NIFTY|13-Oct-2026" -> { symbol: "NIFTY", expiry: "13-Oct-2026" } */
export function parseSourceId(id: string): { symbol: string; expiry: string } | null {
    const [venue, symbol, expiry] = id.split("|");
    return venue === "NSE" && symbol && expiry ? { symbol, expiry } : null;
}

/** Expiry close time (15:30 local) for a source, e.g. "NSE|NIFTY|13-Oct-2026". */
export function expiryTime(id: string): number | null {
    const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(parseSourceId(id)?.expiry ?? "");
    if (!m) return null;
    const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(
        m[2].toLowerCase()
    );
    return month < 0 ? null : new Date(Number(m[3]), month, Number(m[1]), 15, 30).getTime();
}
