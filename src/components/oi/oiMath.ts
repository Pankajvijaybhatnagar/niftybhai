import type { OIRow, OISnapshot } from "./oiData";

export type Side = "CE" | "PE";
export type Speed = "Fast" | "Normal" | "Slow" | "Flat" | "Warming up";
export type Trend = "Accelerating" | "Steady" | "Slowing" | "-";
export type Bias = "Bullish" | "Bearish" | "Neutral";
export type Action =
    | "Long buildup"
    | "Short buildup"
    | "Short covering"
    | "Long unwinding"
    | "Fresh positions"
    | "Positions closed";

const minutes = (ms: number) => ms / 60_000;

/** Latest snapshot index taken at or before time t (or 0). */
function indexAtOrBefore(history: OISnapshot[], t: number): number {
    for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].t <= t) return i;
    }
    return 0;
}

const byStrike = (rows: OIRow[]) => new Map(rows.map((r) => [r.strike, r]));

// =========================
// Speed: the current window's rate compared with this series' own typical
// pace for the session (sum of |change| / session minutes).
// =========================
export function classifySpeed(rate: number, typical: number, ready: boolean): Speed {
    if (!ready) return "Warming up";
    if (rate === 0 && typical === 0) return "Flat";
    if (typical === 0) return "Fast";
    const ratio = Math.abs(rate) / typical;
    if (ratio >= 1.5) return "Fast";
    if (ratio <= 0.5) return "Slow";
    return "Normal";
}

export function classifyTrend(rate: number, prevRate: number | null): Trend {
    if (prevRate === null) return "-";
    const now = Math.abs(rate);
    const before = Math.abs(prevRate);
    if (before === 0) return now > 0 ? "Accelerating" : "Steady";
    if (now > before * 1.25) return "Accelerating";
    if (now < before * 0.8) return "Slowing";
    return "Steady";
}

export interface SideRate {
    delta: number;
    rate: number; // contracts per minute
    typical: number; // contracts per minute, session average of |change|
    speed: Speed;
    trend: Trend;
}

export interface TotalVelocity {
    ce: SideRate;
    pe: SideRate;
    spanMin: number;
    ready: boolean;
}

export interface StrikeVelocity {
    strike: number;
    ce: SideRate;
    pe: SideRate;
}

export interface VelocityResult {
    totals: TotalVelocity | null;
    strikes: StrikeVelocity[];
}

export function computeVelocity(history: OISnapshot[], windowMin: number): VelocityResult {
    if (history.length < 2) return { totals: null, strikes: [] };

    const last = history[history.length - 1];
    const first = history[0];
    const windowMs = windowMin * 60_000;

    const baseIdx = indexAtOrBefore(history, last.t - windowMs);
    const base = history[baseIdx];
    const spanMin = Math.max(minutes(last.t - base.t), 1 / 60);

    const prevIdx = indexAtOrBefore(history, base.t - windowMs);
    const prev = history[prevIdx];
    const hasPrev = prevIdx < baseIdx && base.t - prev.t >= windowMs * 0.5;
    const prevSpanMin = Math.max(minutes(base.t - prev.t), 1 / 60);

    const sessionMin = Math.max(minutes(last.t - first.t), 1 / 60);
    const ready = sessionMin >= windowMin * 2 && last.t - base.t >= windowMs * 0.5;

    // session typical pace, total and per strike
    let ceAbs = 0;
    let peAbs = 0;
    const strikeAbs = new Map<number, { ce: number; pe: number }>();
    for (let i = 1; i < history.length; i++) {
        const a = history[i - 1];
        const b = history[i];
        ceAbs += Math.abs(b.totals.ceOI - a.totals.ceOI);
        peAbs += Math.abs(b.totals.peOI - a.totals.peOI);

        const prevRows = byStrike(a.rows);
        for (const row of b.rows) {
            const p = prevRows.get(row.strike);
            if (!p) continue;
            const acc = strikeAbs.get(row.strike) ?? { ce: 0, pe: 0 };
            acc.ce += Math.abs(row.ceOI - p.ceOI);
            acc.pe += Math.abs(row.peOI - p.peOI);
            strikeAbs.set(row.strike, acc);
        }
    }

    const sideRate = (
        nowVal: number,
        baseVal: number,
        prevVal: number | null,
        typical: number
    ): SideRate => {
        const delta = nowVal - baseVal;
        const rate = delta / spanMin;
        const prevRate = prevVal === null ? null : (baseVal - prevVal) / prevSpanMin;
        return {
            delta,
            rate,
            typical,
            speed: classifySpeed(rate, typical, ready),
            trend: ready ? classifyTrend(rate, prevRate) : "-",
        };
    };

    const totals: TotalVelocity = {
        ce: sideRate(last.totals.ceOI, base.totals.ceOI, hasPrev ? prev.totals.ceOI : null, ceAbs / sessionMin),
        pe: sideRate(last.totals.peOI, base.totals.peOI, hasPrev ? prev.totals.peOI : null, peAbs / sessionMin),
        spanMin,
        ready,
    };

    const baseRows = byStrike(base.rows);
    const prevRows = byStrike(prev.rows);
    const strikes: StrikeVelocity[] = [];
    for (const row of last.rows) {
        const b = baseRows.get(row.strike);
        if (!b) continue;
        const p = hasPrev ? prevRows.get(row.strike) ?? null : null;
        const abs = strikeAbs.get(row.strike) ?? { ce: 0, pe: 0 };
        strikes.push({
            strike: row.strike,
            ce: sideRate(row.ceOI, b.ceOI, p ? p.ceOI : null, abs.ce / sessionMin),
            pe: sideRate(row.peOI, b.peOI, p ? p.peOI : null, abs.pe / sessionMin),
        });
    }

    return { totals, strikes };
}

// =========================
// Big-player detection: an OI jump between two consecutive updates that is
// far outside the session's normal update size (>= 5x the median jump and in
// the top 5% of all jumps). The option's price move in the same update says
// who was on the other side (buyers vs writers).
// =========================
export interface BigEvent {
    t: number;
    strike: number;
    side: Side;
    dOI: number;
    dLTP: number;
    dVol: number;
    oiAfter: number;
    multiple: number; // x times the median update size
    action: Action;
    bias: Bias;
}

export interface BigPlayerResult {
    ready: boolean;
    threshold: number;
    median: number;
    events: BigEvent[]; // newest first
}

const MIN_SAMPLES = 40;

export function classifyAction(dOI: number, dLTP: number): Action {
    if (dOI > 0) return dLTP > 0 ? "Long buildup" : dLTP < 0 ? "Short buildup" : "Fresh positions";
    return dLTP > 0 ? "Short covering" : dLTP < 0 ? "Long unwinding" : "Positions closed";
}

export function actionBias(side: Side, action: Action): Bias {
    const callView: Record<Action, Bias> = {
        "Long buildup": "Bullish",
        "Short buildup": "Bearish",
        "Short covering": "Bullish",
        "Long unwinding": "Bearish",
        "Fresh positions": "Neutral",
        "Positions closed": "Neutral",
    };
    const bias = callView[action];
    if (side === "CE" || bias === "Neutral") return bias;
    return bias === "Bullish" ? "Bearish" : "Bullish";
}

export function actionMeaning(side: Side, action: Action): string {
    const meaning: Record<Side, Record<Action, string>> = {
        CE: {
            "Long buildup": "Call buyers entering",
            "Short buildup": "Call writing - resistance building",
            "Short covering": "Call writers exiting",
            "Long unwinding": "Call buyers exiting",
            "Fresh positions": "New call positions",
            "Positions closed": "Call positions closed",
        },
        PE: {
            "Long buildup": "Put buyers entering",
            "Short buildup": "Put writing - support building",
            "Short covering": "Put writers exiting",
            "Long unwinding": "Put buyers exiting",
            "Fresh positions": "New put positions",
            "Positions closed": "Put positions closed",
        },
    };
    return meaning[side][action];
}

const quantile = (sorted: number[], q: number) =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))))];

export function detectBigPlayers(history: OISnapshot[]): BigPlayerResult {
    const jumps: number[] = [];

    for (let i = 1; i < history.length; i++) {
        const prevRows = byStrike(history[i - 1].rows);
        for (const row of history[i].rows) {
            const p = prevRows.get(row.strike);
            if (!p) continue;
            const ce = Math.abs(row.ceOI - p.ceOI);
            const pe = Math.abs(row.peOI - p.peOI);
            if (ce > 0) jumps.push(ce);
            if (pe > 0) jumps.push(pe);
        }
    }

    if (jumps.length < MIN_SAMPLES) {
        return { ready: false, threshold: 0, median: 0, events: [] };
    }

    jumps.sort((a, b) => a - b);
    const median = Math.max(1, quantile(jumps, 0.5));
    const threshold = Math.max(median * 5, quantile(jumps, 0.95));

    const events: BigEvent[] = [];
    for (let i = 1; i < history.length; i++) {
        const snap = history[i];
        const prevRows = byStrike(history[i - 1].rows);
        for (const row of snap.rows) {
            const p = prevRows.get(row.strike);
            if (!p) continue;

            const sides: [Side, number, number, number, number][] = [
                ["CE", row.ceOI - p.ceOI, row.ceLTP - p.ceLTP, row.ceVol - p.ceVol, row.ceOI],
                ["PE", row.peOI - p.peOI, row.peLTP - p.peLTP, row.peVol - p.peVol, row.peOI],
            ];

            for (const [side, dOI, dLTP, dVol, oiAfter] of sides) {
                if (Math.abs(dOI) < threshold) continue;
                const action = classifyAction(dOI, dLTP);
                events.push({
                    t: snap.t,
                    strike: row.strike,
                    side,
                    dOI,
                    dLTP,
                    dVol,
                    oiAfter,
                    multiple: Math.abs(dOI) / median,
                    action,
                    bias: actionBias(side, action),
                });
            }
        }
    }

    events.sort((a, b) => b.t - a.t || Math.abs(b.dOI) - Math.abs(a.dOI));
    return { ready: true, threshold, median, events };
}

/** Strikes where big players added the most fresh OI, per side. */
export interface BigZone {
    strike: number;
    side: Side;
    added: number;
    count: number;
    lastAction: Action;
}

export function bigMoneyZones(events: BigEvent[], limit = 4): BigZone[] {
    const zones = new Map<string, BigZone>();
    // events are newest first, so the first one seen per zone is its latest action
    for (const e of events) {
        if (e.dOI <= 0) continue;
        const key = `${e.side}|${e.strike}`;
        const zone = zones.get(key) ?? { strike: e.strike, side: e.side, added: 0, count: 0, lastAction: e.action };
        zone.added += e.dOI;
        zone.count += 1;
        zones.set(key, zone);
    }
    return [...zones.values()].sort((a, b) => b.added - a.added).slice(0, limit);
}

// =========================
// Formatting (Indian compact units: K, L, Cr)
// =========================
export function fmtCompact(n: number, signed = false): string {
    const sign = n < 0 ? "-" : signed && n > 0 ? "+" : "";
    const a = Math.abs(n);
    let body: string;
    if (a >= 1e7) body = `${(a / 1e7).toFixed(2)}Cr`;
    else if (a >= 1e5) body = `${(a / 1e5).toFixed(2)}L`;
    else if (a >= 1e3) body = `${(a / 1e3).toFixed(1)}K`;
    else body = a >= 10 || a === 0 ? `${Math.round(a)}` : a.toFixed(1);
    return sign + body;
}

export const fmtFull = (n: number) => n.toLocaleString("en-IN");

export const fmtTime = (t: number) =>
    new Date(t).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false });

export const fmtTimeSec = (t: number) =>
    new Date(t).toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    });

// =========================
// CE / PE OI crossover: past crossings plus a straight-line forecast of the
// gap (PE OI - CE OI) fitted over the recent lookback. A forecast is only a
// projection of the current trend, not a guarantee.
// =========================
export type Leader = "CE" | "PE" | "Equal";
export type Confidence = "High" | "Medium" | "Low";
export type RateUnit = "min" | "day";

// a trading day is ~1.4 calendar days on average (5 trading days per 7)
const TRADING_DAY_MS = (7 / 5) * 86_400_000;
export const DAILY_TREND_POINTS = 5;

export interface CrossPoint {
    t: number;
    value: number;
    above: Side; // the side that went on top
}

export interface CrossForecast {
    ready: boolean;
    status: string;
    gap: number; // PE - CE, now
    leader: Leader;
    gapRate: number; // change in gap per unit
    ceRate: number; // per unit
    peRate: number; // per unit
    converging: boolean;
    unit: RateUnit; // minutes (intraday) or trading days (daily)
    unitMs: number; // chart time per unit, used to draw the projection
    eta: number | null; // in units

    crossAt: number | null;
    crossValue: number | null;
    nextAbove: Side | null;
    afterClose: boolean;
    confidence: Confidence;
    pastCrosses: CrossPoint[];
}

function linearFit(xs: number[], ys: number[]) {
    const n = xs.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (let i = 0; i < n; i++) {
        sxy += (xs[i] - mx) * (ys[i] - my);
        sxx += (xs[i] - mx) ** 2;
        syy += (ys[i] - my) ** 2;
    }
    const slope = sxx ? sxy / sxx : 0;
    const r2 = sxx && syy ? (sxy * sxy) / (sxx * syy) : 0;
    return { slope, r2 };
}

/** 15:30 local time today - NSE close, assuming the viewer is on IST. */
function marketClose(t: number) {
    const d = new Date(t);
    d.setHours(15, 30, 0, 0);
    return d.getTime();
}

export const crossMeaning = (above: Side) =>
    above === "PE" ? "Put OI on top - writers defending this strike as support" : "Call OI on top - writers defending this strike as resistance";

export function forecastCrossover(
    times: number[],
    ce: number[],
    pe: number[],
    lookbackMin: number,
    options: { daily?: boolean; expiryAt?: number | null; names?: [string, string] } = {}
): CrossForecast {
    const daily = options.daily ?? false;
    // display names for the "ce" and "pe" lines (another pair of series can be passed in)
    const [nameCE, namePE] = options.names ?? ["CE OI", "PE OI"];
    const nameOf = (s: Side | Leader) => (s === "CE" ? nameCE : s === "PE" ? namePE : s);
    const unit: RateUnit = daily ? "day" : "min";
    const unitMs = daily ? TRADING_DAY_MS : 60_000;
    const n = times.length;
    const last = n - 1;
    const gap = n ? pe[last] - ce[last] : 0;
    const leader: Leader = gap > 0 ? "PE" : gap < 0 ? "CE" : "Equal";

    // compare against the last non-zero gap, so touching level and then
    // flipping still counts as one crossing
    const pastCrosses: CrossPoint[] = [];
    let prev = -1;
    for (let i = 0; i < n; i++) {
        const g1 = pe[i] - ce[i];
        if (g1 === 0) continue;
        if (prev >= 0) {
            const g0 = pe[prev] - ce[prev];
            if (Math.sign(g0) !== Math.sign(g1)) {
                const f = g0 / (g0 - g1);
                pastCrosses.push({
                    t: times[prev] + f * (times[i] - times[prev]),
                    value: ce[prev] + f * (ce[i] - ce[prev]),
                    above: g1 > 0 ? "PE" : "CE",
                });
            }
        }
        prev = i;
    }

    const base: CrossForecast = {
        ready: false,
        status: "",
        gap,
        leader,
        gapRate: 0,
        ceRate: 0,
        peRate: 0,
        converging: false,
        unit,
        unitMs,
        eta: null,
        crossAt: null,
        crossValue: null,
        nextAbove: null,
        afterClose: false,
        confidence: "Low",
        pastCrosses,
    };

    if (n < 2) {
        return { ...base, status: daily ? "Need at least 3 trading days of data" : "Waiting for live updates" };
    }

    // x axis: minutes before the last update (intraday) or trading days (daily)
    let start = 0;
    let xs: number[];
    if (daily) {
        if (n < 3) return { ...base, status: "Need at least 3 trading days of data" };
        // trend from the most recent trading days only, whatever range is on screen
        start = Math.max(0, last - (DAILY_TREND_POINTS - 1));
        xs = times.slice(start).map((_, i) => i - (last - start));
    } else {
        const from = times[last] - lookbackMin * 60_000;
        start = last;
        while (start > 0 && times[start - 1] >= from) start--;
        const spanMin = (times[last] - times[start]) / 60_000;

        if (last - start + 1 < 5 || spanMin < lookbackMin * 0.4) {
            const need = Math.max(1, Math.ceil(lookbackMin * 0.4 - spanMin));
            return { ...base, status: `Need about ${need} more min of live data to forecast` };
        }
        xs = times.slice(start).map((t) => (t - times[last]) / 60_000);
    }
    const count = last - start + 1;

    const ceFit = linearFit(xs, ce.slice(start));
    const peFit = linearFit(xs, pe.slice(start));
    const gapFit = linearFit(xs, xs.map((_, i) => pe[start + i] - ce[start + i]));

    const gapRate = peFit.slope - ceFit.slope;
    const scale = Math.max(Math.abs(ce[last]), Math.abs(pe[last]), 1);
    // under 0.05% of OI per minute, or 0.5% per trading day
    const flat = Math.abs(gapRate) < scale * (daily ? 0.005 : 0.0005);
    const converging = gap !== 0 && !flat && Math.sign(gapRate) === -Math.sign(gap);

    const confidence: Confidence =
        gapFit.r2 >= 0.7 && count >= (daily ? 5 : 10) ? "High" : gapFit.r2 >= 0.4 ? "Medium" : "Low";

    const out: CrossForecast = {
        ...base,
        ready: true,
        gapRate,
        ceRate: ceFit.slope,
        peRate: peFit.slope,
        converging,
        confidence,
    };

    if (gap === 0) return { ...out, status: `${nameCE} and ${namePE} are level right now` };

    if (converging) {
        const eta = -gap / gapRate;
        const horizon = daily ? 10 : 120;
        if (eta > horizon) {
            return {
                ...out,
                status: `Converging slowly - no crossover expected in the next ${daily ? "2 weeks" : "2h"}`,
            };
        }

        const crossAt = times[last] + eta * unitMs;
        if (options.expiryAt && crossAt > options.expiryAt) {
            return { ...out, status: `Converging, but too slowly to cross before expiry (${fmtDate(options.expiryAt)})` };
        }
        const afterClose = !daily && crossAt > marketClose(times[last]);
        const nextAbove: Side = gap > 0 ? "CE" : "PE";
        const when = daily
            ? `~${eta < 1 ? "<1" : Math.round(eta)} trading day${Math.round(eta) === 1 || eta < 1 ? "" : "s"} (≈ ${fmtDate(crossAt)})`
            : `~${Math.max(1, Math.round(eta))} min (≈ ${fmtTime(crossAt)})`;

        return {
            ...out,
            eta,
            crossAt,
            crossValue: ce[last] + ceFit.slope * eta,
            nextAbove,
            afterClose,
            status: afterClose
                ? `Converging - would cross around ${fmtTime(crossAt)}, after market close`
                : `Converging - ${nameOf(nextAbove)} may cross above ${nameOf(leader)} in ${when}`,
        };
    }

    if (flat) return { ...out, status: `Gap holding steady - ${nameOf(leader)} stays on top` };
    return { ...out, status: `Moving apart - ${nameOf(leader)} lead is widening, no crossover expected` };
}

/** "in ~12 min" / "in ~3 trading days" for a forecast's eta. */
export function etaText(fc: CrossForecast): string {
    if (fc.eta === null) return "";
    if (fc.unit === "min") return `~${Math.max(1, Math.round(fc.eta))}m`;
    return fc.eta < 1 ? "<1 day" : `~${Math.round(fc.eta)}d`;
}

export const fmtDate = (t: number) =>
    new Date(t).toLocaleDateString("en-IN", { day: "2-digit", month: "short" });

// =========================
// Shift forecast based on the option chain's own signal logic.
// Support / resistance there = the highest cell of one "winning" column
// (OI, Chg OI or Volume) per side, and the runner-up is flagged once it
// reaches 78% of that max. So the questions here are: is the runner-up
// heading for 78%, and will it overtake the max - moving the line to its strike?
// =========================
export type HotField = "ceOI" | "ceChg" | "ceVol" | "peOI" | "peChg" | "peVol";

/** Read-only copy of the levels computed by the option chain table. */
export interface SignalLevels {
    spot: number;
    supportStrike: number | null;
    resistanceStrike: number | null;
    supportField: HotField | null;
    resistanceField: HotField | null;
    ceSecondStrike: number | null;
    peSecondStrike: number | null;
    atmStrike: number | null;
    maxPainStrike: number | null;
    callBuy: number | null;
    putBuy: number | null;
}

export const SECOND_HIGHEST_PCT = 0.78;

export const FIELD_LABEL: Record<HotField, string> = {
    ceOI: "CE OI",
    ceChg: "CE Chg OI",
    ceVol: "CE Volume",
    peOI: "PE OI",
    peChg: "PE Chg OI",
    peVol: "PE Volume",
};

export interface LevelShift {
    kind: "Support" | "Resistance";
    field: HotField;
    lineStrike: number;
    challenger: number | null;
    pct: number | null; // challenger as a share of the line's value, now
    pctRate: number | null; // change in that share per minute
    reach78: { eta: number; at: number } | null;
    overtake: CrossForecast | null;
    times: number[];
    lineValues: number[];
    challengerValues: number[];
    note: string;
}

export function forecastLevelShift(
    kind: "Support" | "Resistance",
    field: HotField,
    lineStrike: number,
    history: OISnapshot[],
    lookbackMin: number,
    expiryAt: number | null
): LevelShift {
    const empty: LevelShift = {
        kind,
        field,
        lineStrike,
        challenger: null,
        pct: null,
        pctRate: null,
        reach78: null,
        overtake: null,
        times: [],
        lineValues: [],
        challengerValues: [],
        note: "",
    };

    const latest = history[history.length - 1];
    if (!latest) return { ...empty, note: "Waiting for live updates" };

    const lineNow = latest.rows.find((r) => r.strike === lineStrike);
    if (!lineNow) return { ...empty, note: `${lineStrike} is outside the tracked strikes` };

    // runner-up in the same column right now (same rule as the table, minus the 78% cut-off)
    let challenger: OIRow | null = null;
    for (const r of latest.rows) {
        if (r.strike === lineStrike) continue;
        if (!challenger || r[field] > challenger[field]) challenger = r;
    }
    if (!challenger || lineNow[field] <= 0) return { ...empty, note: "No runner-up to compare yet" };
    const challengerStrike = challenger.strike;

    const times: number[] = [];
    const lineValues: number[] = [];
    const challengerValues: number[] = [];
    for (const snap of history) {
        const a = snap.rows.find((r) => r.strike === lineStrike);
        const b = snap.rows.find((r) => r.strike === challengerStrike);
        if (!a || !b) continue;
        times.push(snap.t);
        lineValues.push(a[field]);
        challengerValues.push(b[field]);
    }

    const pct = challenger[field] / lineNow[field];
    const base = { ...empty, challenger: challengerStrike, pct, times, lineValues, challengerValues };

    // challenger plays the "CE" line and the current max the "PE" line
    const overtake = forecastCrossover(times, challengerValues, lineValues, lookbackMin, {
        expiryAt,
        names: [`${challengerStrike}`, `${lineStrike}`],
    });

    // trend of the runner-up's share of the max over the same lookback
    let pctRate: number | null = null;
    let reach78: LevelShift["reach78"] = null;
    if (times.length >= 5) {
        const from = times[times.length - 1] - lookbackMin * 60_000;
        const idx = times.map((t, i) => (t >= from && lineValues[i] > 0 ? i : -1)).filter((i) => i >= 0);
        if (idx.length >= 5) {
            const last = times[times.length - 1];
            const fit = linearFit(
                idx.map((i) => (times[i] - last) / 60_000),
                idx.map((i) => challengerValues[i] / lineValues[i])
            );
            pctRate = fit.slope;
            if (pct < SECOND_HIGHEST_PCT && fit.slope > 0) {
                const eta = (SECOND_HIGHEST_PCT - pct) / fit.slope;
                const at = last + eta * 60_000;
                if (eta <= 120 && (!expiryAt || at <= expiryAt)) reach78 = { eta, at };
            }
        }
    }

    return { ...base, overtake, pctRate, reach78 };
}

/** Tags for a strike's role in the option chain's own signal logic. */
export function strikeRoles(strike: number, levels: SignalLevels | null | undefined): string[] {
    if (!levels) return [];
    const roles: string[] = [];
    if (strike === levels.supportStrike) roles.push("Support");
    if (strike === levels.resistanceStrike) roles.push("Resistance");
    if (strike === levels.peSecondStrike) roles.push("2nd high PE");
    if (strike === levels.ceSecondStrike) roles.push("2nd high CE");
    if (strike === levels.atmStrike) roles.push("ATM");
    if (strike === levels.maxPainStrike) roles.push("Max pain");
    return roles;
}
