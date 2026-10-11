import React, { useEffect, useMemo, useRef, useState } from "react";
import "./oiAnalytics.css";
import type { OISnapshot, OISource } from "./oiData";
import { expiryTime } from "./oiData";
import type { Side, Speed, Trend } from "./oiMath";
import {
    actionMeaning,
    computeVelocity,
    crossMeaning,
    detectBigPlayers,
    fmtCompact,
    fmtFull,
    DAILY_TREND_POINTS,
    etaText,
    fmtDate,
    fmtTime,
    fmtTimeSec,
    forecastCrossover,
    strikeRoles,
} from "./oiMath";
import type { SignalLevels } from "./oiMath";
import type { TimeRange } from "./oiDaily";
import { isDailyRange, rangeDays, seriesForRange, TIME_RANGES, useDailyHistory } from "./oiDaily";
import type { ChartMarker, ForecastOverlay } from "./OICharts";
import { CE_COLOR, Legend, PE_COLOR, StrikeBarChart, TimeLineChart } from "./OICharts";

export type CellMetric = "oi" | "chg" | "vol" | "ltp";

export interface CellSelection {
    strike: number;
    side: Side;
    metric: CellMetric;
}

const METRICS: { key: CellMetric; label: string }[] = [
    { key: "oi", label: "Open interest" },
    { key: "chg", label: "Change in OI" },
    { key: "vol", label: "Volume" },
    { key: "ltp", label: "Premium" },
];

// OI itself is shown in the crossover chart, so the metric chart offers the rest
const OTHER_METRICS = METRICS.filter((m) => m.key !== "oi");

const WINDOWS = [1, 3, 5, 15];
const LOOKBACKS = [5, 15, 30, 60];
const NEIGHBOURS = 6;

const SPEED_LEVEL: Record<Speed, number> = { Fast: 3, Normal: 2, Slow: 1, Flat: 0, "Warming up": 0 };
const TREND_ICON: Record<Trend, string> = { Accelerating: "↗", Steady: "→", Slowing: "↘", "-": "" };

interface Props {
    selection: CellSelection;
    source: OISource | null;
    history: OISnapshot[];
    onClose: () => void;
    levels?: SignalLevels | null;
}

const StrikeDrawer: React.FC<Props> = ({ selection, source, history, onClose, levels }) => {
    const { strike, side } = selection;
    const [metric, setMetric] = useState<CellMetric>(selection.metric === "oi" ? "chg" : selection.metric);
    const [windowMin, setWindowMin] = useState(5);
    const [lookback, setLookback] = useState(15);
    const [range, setRange] = useState<TimeRange>("1D");
    const closeRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        closeRef.current?.focus();
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);

    const row = source?.rows.find((r) => r.strike === strike) ?? null;

    const neighbours = useMemo(() => {
        if (!source) return [];
        const sorted = [...source.rows].sort((a, b) => a.strike - b.strike);
        const i = sorted.findIndex((r) => r.strike === strike);
        if (i < 0) return [];
        return sorted.slice(Math.max(0, i - NEIGHBOURS), i + NEIGHBOURS + 1);
    }, [source, strike]);

    const daily = isDailyRange(range);
    const expiryAt = source ? expiryTime(source.id) : null;
    const dailyHistory = useDailyHistory(source, rangeDays(range), daily);
    const ranged = useMemo(
        () => seriesForRange(range, history, dailyHistory.snapshots),
        [range, history, dailyHistory.snapshots]
    );

    // this strike's values across the selected range
    const timeline = useMemo(() => {
        const times: number[] = [];
        const ce: number[] = [];
        const pe: number[] = [];
        for (const snap of ranged) {
            const r = snap.rows.find((x) => x.strike === strike);
            if (!r) continue;
            times.push(snap.t);
            if (metric === "oi") { ce.push(r.ceOI); pe.push(r.peOI); }
            if (metric === "chg") { ce.push(r.ceChg); pe.push(r.peChg); }
            if (metric === "vol") { ce.push(r.ceVol); pe.push(r.peVol); }
            if (metric === "ltp") { ce.push(r.ceLTP); pe.push(r.peLTP); }
        }
        return { times, ce, pe };
    }, [ranged, strike, metric]);

    // CE vs PE OI at this strike, for the crossover chart
    const oiLine = useMemo(() => {
        const times: number[] = [];
        const ce: number[] = [];
        const pe: number[] = [];
        for (const snap of ranged) {
            const r = snap.rows.find((x) => x.strike === strike);
            if (!r) continue;
            times.push(snap.t);
            ce.push(r.ceOI);
            pe.push(r.peOI);
        }
        return { times, ce, pe };
    }, [ranged, strike]);

    const cross = useMemo(
        () => forecastCrossover(oiLine.times, oiLine.ce, oiLine.pe, lookback, { daily, expiryAt }),
        [oiLine, lookback, daily, expiryAt]
    );

    const overlay = useMemo<ForecastOverlay | null>(() => {
        if (!cross.ready || !oiLine.times.length) return null;
        const t1 = oiLine.times[oiLine.times.length - 1];
        // how far ahead to draw, in forecast units (minutes or trading days)
        const ahead =
            cross.eta !== null
                ? Math.min(cross.eta * 1.3 + (daily ? 0.5 : 2), daily ? 10 : 120)
                : daily
                    ? 3
                    : Math.min(lookback, 30);
        const perMinute = 60_000 / cross.unitMs;
        return {
            until: t1 + ahead * cross.unitMs,
            slopes: { ce: cross.ceRate * perMinute, pe: cross.peRate * perMinute },
            cross:
                cross.crossAt !== null && cross.crossValue !== null
                    ? {
                        t: cross.crossAt,
                        v: cross.crossValue,
                        label: `≈ ${daily ? fmtDate(cross.crossAt) : fmtTime(cross.crossAt)}`,
                    }
                    : null,
        };
    }, [cross, oiLine, lookback, daily]);

    const crossMarkers = useMemo<ChartMarker[]>(
        () =>
            cross.pastCrosses.map((c) => ({
                t: c.t,
                v: c.value,
                label: `${c.above} crossed above at ${daily ? fmtDate(c.t) : fmtTimeSec(c.t)}`,
            })),
        [cross, daily]
    );

    const whenText = (t: number) => (daily ? fmtDate(t) : fmtTimeSec(t));

    // what a crossover here means for the option chain's own levels
    const roles = strikeRoles(strike, levels);
    let roleNote = "";
    if (levels && cross.nextAbove) {
        if (strike === levels.supportStrike && cross.nextAbove === "CE") {
            roleNote = `This is your support strike (CALL BUY ${levels.callBuy ?? "-"}). Calls overtaking puts here would weaken that support.`;
        } else if (strike === levels.resistanceStrike && cross.nextAbove === "PE") {
            roleNote = `This is your resistance strike (PUT BUY ${levels.putBuy ?? "-"}). Puts overtaking calls here would weaken that resistance.`;
        } else if (strike === levels.supportStrike || strike === levels.resistanceStrike) {
            roleNote = `This is your ${strike === levels.supportStrike ? "support" : "resistance"} strike - the projected crossover would strengthen it.`;
        }
    }

    const crossTone = cross.converging && cross.eta !== null ? "near" : cross.ready ? "calm" : "wait";
    const crossIcon = crossTone === "near" ? "⇄" : crossTone === "calm" ? "⇉" : "…";

    const pace = useMemo(
        () => computeVelocity(history, windowMin).strikes.find((v) => v.strike === strike) ?? null,
        [history, windowMin, strike]
    );

    const events = useMemo(
        () => detectBigPlayers(history).events.filter((e) => e.strike === strike),
        [history, strike]
    );

    const metricLabel = METRICS.find((m) => m.key === metric)!.label;
    const isPrice = metric === "ltp";
    const fmt = isPrice ? (n: number) => n.toFixed(Math.abs(n) < 100 ? 1 : 0) : (n: number) => fmtCompact(n);
    const tipFmt = isPrice ? (n: number) => `₹${n.toFixed(2)}` : fmtFull;

    const strikePcr = row && row.ceOI ? row.peOI / row.ceOI : null;
    const spotGap = source ? strike - source.spot : 0;

    const stat = (label: string, ce: string, pe: string) => (
        <div className="sd-stat">
            <div className="sd-stat-label">{label}</div>
            <div className="sd-stat-pair">
                <span className={side === "CE" ? "sd-focus" : ""}>
                    <span className="oi-side-key" style={{ background: CE_COLOR }} />
                    {ce}
                </span>
                <span className={side === "PE" ? "sd-focus" : ""}>
                    <span className="oi-side-key" style={{ background: PE_COLOR }} />
                    {pe}
                </span>
            </div>
        </div>
    );

    const paceRow = (label: Side) => {
        const p = label === "CE" ? pace?.ce : pace?.pe;
        return (
            <div className={`sd-pace ${side === label ? "sd-pace-focus" : ""}`}>
                <div className="oi-side">
                    <span className="oi-side-key" style={{ background: label === "CE" ? CE_COLOR : PE_COLOR }} />
                    {label}
                </div>
                {p ? (
                    <>
                        <div className="sd-pace-rate">{fmtCompact(p.rate, true)}/min</div>
                        <div className="sd-pace-meta">
                            {fmtCompact(p.delta, true)} in {windowMin}m
                        </div>
                        <div className="sd-pace-meta">
                            <span className="oi-speed">
                                <span className="oi-meter" aria-hidden="true">
                                    {[1, 2, 3].map((n) => (
                                        <span key={n} className={n <= SPEED_LEVEL[p.speed] ? "on" : ""} />
                                    ))}
                                </span>
                                {p.speed}
                            </span>
                        </div>
                        <div className="sd-pace-meta">
                            {TREND_ICON[p.trend]} {p.trend === "-" ? "" : p.trend}
                        </div>
                    </>
                ) : (
                    <div className="sd-pace-meta">Needs two live updates</div>
                )}
            </div>
        );
    };

    return (
        <div className="sd-root oi-theme" role="presentation">
            <div className="sd-backdrop" onClick={onClose} />
            <aside className="sd-panel" role="dialog" aria-modal="true" aria-label={`Strike ${strike} charts`}>
                <header className="sd-head">
                    <div>
                        <div className="sd-eyebrow">
                            {side} {METRICS.find((m) => m.key === selection.metric)!.label}
                        </div>
                        <h3 className="sd-title">Strike {strike}</h3>
                        {source && (
                            <div className="sd-sub">
                                Spot {fmtFull(Number(source.spot.toFixed(2)))} ·{" "}
                                {Math.abs(spotGap) < 1
                                    ? "at the money"
                                    : `${fmtFull(Math.abs(Math.round(spotGap)))} pts ${spotGap > 0 ? "above" : "below"} spot`}
                                {strikePcr !== null && ` · Strike PCR ${strikePcr.toFixed(2)}`}
                            </div>
                        )}
                        {roles.length > 0 && (
                            <div className="sd-roles">
                                {roles.map((r) => (
                                    <span key={r} className="oi-role">
                                        {r}
                                    </span>
                                ))}
                            </div>
                        )}
                    </div>
                    <button ref={closeRef} type="button" className="sd-close" onClick={onClose} aria-label="Close">
                        ✕
                    </button>
                </header>

                <div className="sd-body">
                    {row && (
                        <div className="sd-stats">
                            {stat("Open interest", fmtCompact(row.ceOI), fmtCompact(row.peOI))}
                            {stat("Change in OI", fmtCompact(row.ceChg, true), fmtCompact(row.peChg, true))}
                            {stat("Volume", fmtCompact(row.ceVol), fmtCompact(row.peVol))}
                            {stat("Premium", `₹${row.ceLTP.toFixed(2)}`, `₹${row.peLTP.toFixed(2)}`)}
                        </div>
                    )}

                    <section className="oi-card">
                        <div className="oi-card-head">
                            <div>
                                <h4>CE vs PE OI - crossover</h4>
                                <p>
                                    {daily
                                        ? `Solid = closing OI each trading day (last point is live), dashed = forecast from the last ${DAILY_TREND_POINTS} trading days.`
                                        : `Solid = actual, dashed = forecast from the last ${lookback} min trend.`}{" "}
                                    ✕ marks past crossings.
                                </p>
                            </div>
                            <Legend
                                items={[
                                    { label: "CE OI", color: CE_COLOR, kind: "line" },
                                    { label: "PE OI", color: PE_COLOR, kind: "line" },
                                ]}
                            />
                        </div>

                        <div className="oi-seg sd-seg" role="group" aria-label="Time range">
                            <span className="oi-seg-label">Range</span>
                            {TIME_RANGES.map((r) => (
                                <button
                                    key={r}
                                    type="button"
                                    className={r === range ? "active" : ""}
                                    aria-pressed={r === range}
                                    onClick={() => setRange(r)}
                                >
                                    {r}
                                </button>
                            ))}
                        </div>

                        {dailyHistory.loading && <div className="oi-notice">Loading daily OI from NSE...</div>}
                        {dailyHistory.error && (
                            <div className="oi-notice">Some days could not be loaded: {dailyHistory.error}</div>
                        )}

                        <div className={`sd-cross-status sd-cross-${crossTone}`}>
                            <span aria-hidden="true">{crossIcon}</span>
                            {cross.status}
                        </div>

                        {!daily && (
                            <div className="oi-seg sd-seg" role="group" aria-label="Forecast lookback">
                                <span className="oi-seg-label">Trend from last</span>
                                {LOOKBACKS.map((l) => (
                                    <button
                                        key={l}
                                        type="button"
                                        className={l === lookback ? "active" : ""}
                                        aria-pressed={l === lookback}
                                        onClick={() => setLookback(l)}
                                    >
                                        {l === 60 ? "1h" : `${l}m`}
                                    </button>
                                ))}
                            </div>
                        )}

                        <TimeLineChart
                            times={oiLine.times}
                            series={[
                                { key: "ce", label: "CE", color: CE_COLOR, values: oiLine.ce },
                                { key: "pe", label: "PE", color: PE_COLOR, values: oiLine.pe },
                            ]}
                            forecast={overlay}
                            markers={crossMarkers}
                            height={260}
                            ariaLabel={`Call and put open interest over time at strike ${strike}, with crossover forecast`}
                        />

                        <div className="sd-cross-facts">
                            <div>
                                <span>On top now</span>
                                <strong>
                                    {cross.leader === "Equal" ? "Level" : `${cross.leader} by ${fmtCompact(Math.abs(cross.gap))}`}
                                </strong>
                            </div>
                            <div>
                                <span>Gap per {cross.unit === "day" ? "trading day" : "minute"}</span>
                                <strong>
                                    {cross.ready
                                        ? `${fmtCompact(Math.abs(cross.gapRate))} ${cross.converging ? "closing" : "widening"}`
                                        : "-"}
                                </strong>
                            </div>
                            <div>
                                <span>Expected crossover</span>
                                <strong>
                                    {cross.crossAt !== null
                                        ? `${daily ? fmtDate(cross.crossAt) : fmtTime(cross.crossAt)} (${etaText(cross)})`
                                        : "None"}
                                </strong>
                            </div>
                            <div>
                                <span>Confidence</span>
                                <strong>{cross.ready ? cross.confidence : "-"}</strong>
                            </div>
                        </div>

                        {cross.nextAbove && <p className="sd-cross-note">If it crosses: {crossMeaning(cross.nextAbove)}.</p>}
                        {roleNote && <p className="sd-cross-note sd-role-note">{roleNote}</p>}

                        {cross.pastCrosses.length > 0 && (
                            <ul className="sd-events">
                                {[...cross.pastCrosses]
                                    .reverse()
                                    .slice(0, 5)
                                    .map((c) => (
                                        <li key={c.t}>
                                            <span className="oi-side">
                                                <span
                                                    className="oi-side-key"
                                                    style={{ background: c.above === "CE" ? CE_COLOR : PE_COLOR }}
                                                />
                                                {c.above}
                                            </span>
                                            <span className="sd-ev-main">
                                                <strong>Crossed above {c.above === "CE" ? "PE" : "CE"}</strong>
                                                <span className="oi-muted"> · {crossMeaning(c.above)}</span>
                                            </span>
                                            <span className="sd-ev-meta">{whenText(c.t)}</span>
                                        </li>
                                    ))}
                            </ul>
                        )}
                    </section>

                    <section className="oi-card">
                        <div className="oi-card-head">
                            <div>
                                <h4>{metricLabel} over time</h4>
                                <p>
                                    CE vs PE at {strike},{" "}
                                    {daily ? `closing value each trading day (${range})` : `every live update (${range})`}
                                </p>
                            </div>
                            <Legend
                                items={[
                                    { label: "CE", color: CE_COLOR, kind: "line" },
                                    { label: "PE", color: PE_COLOR, kind: "line" },
                                ]}
                            />
                        </div>
                        <div className="oi-seg sd-seg" role="group" aria-label="Metric">
                            {OTHER_METRICS.map((m) => (
                                <button
                                    key={m.key}
                                    type="button"
                                    className={m.key === metric ? "active" : ""}
                                    aria-pressed={m.key === metric}
                                    onClick={() => setMetric(m.key)}
                                >
                                    {m.label}
                                </button>
                            ))}
                        </div>
                        <TimeLineChart
                            times={timeline.times}
                            series={[
                                { key: "ce", label: "CE", color: CE_COLOR, values: timeline.ce },
                                { key: "pe", label: "PE", color: PE_COLOR, values: timeline.pe },
                            ]}
                            format={fmt}
                            tipFormat={tipFmt}
                            zeroLine={metric === "chg"}
                            ariaLabel={`${metricLabel} over time at strike ${strike}`}
                        />
                    </section>

                    <section className="oi-card">
                        <div className="oi-card-head">
                            <div>
                                <h4>How fast OI is moving here</h4>
                                <p>Speed compares this strike with its own pace for the session</p>
                            </div>
                        </div>
                        <div className="oi-seg sd-seg" role="group" aria-label="Rate window">
                            <span className="oi-seg-label">Window</span>
                            {WINDOWS.map((w) => (
                                <button
                                    key={w}
                                    type="button"
                                    className={w === windowMin ? "active" : ""}
                                    aria-pressed={w === windowMin}
                                    onClick={() => setWindowMin(w)}
                                >
                                    {w}m
                                </button>
                            ))}
                        </div>
                        <div className="sd-paces">
                            {paceRow("CE")}
                            {paceRow("PE")}
                        </div>
                    </section>

                    <section className="oi-card">
                        <div className="oi-card-head">
                            <div>
                                <h4>Open interest around {strike}</h4>
                                <p>{NEIGHBOURS} strikes either side - is this strike the wall, or is a neighbour bigger?</p>
                            </div>
                            <Legend items={[{ label: "CE OI", color: CE_COLOR }, { label: "PE OI", color: PE_COLOR }]} />
                        </div>
                        <StrikeBarChart
                            data={neighbours.map((r) => ({ strike: r.strike, ce: r.ceOI, pe: r.peOI }))}
                            spot={source?.spot ?? 0}
                            highlightStrike={strike}
                            height={220}
                            ariaLabel={`Open interest for strikes around ${strike}`}
                        />
                    </section>

                    <section className="oi-card">
                        <div className="oi-card-head">
                            <div>
                                <h4>Big-player activity at {strike}</h4>
                                <p>Unusually large OI jumps in a single update</p>
                            </div>
                        </div>
                        {events.length ? (
                            <ul className="sd-events">
                                {events.slice(0, 10).map((e) => (
                                    <li key={`${e.t}-${e.side}`}>
                                        <span className="oi-side">
                                            <span
                                                className="oi-side-key"
                                                style={{ background: e.side === "CE" ? CE_COLOR : PE_COLOR }}
                                            />
                                            {e.side}
                                        </span>
                                        <span className="sd-ev-main">
                                            <strong>{fmtCompact(e.dOI, true)}</strong> {e.action}
                                            <span className="oi-muted"> · {actionMeaning(e.side, e.action)}</span>
                                        </span>
                                        <span className="sd-ev-meta">
                                            {e.multiple.toFixed(1)}x · {fmtTimeSec(e.t)}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <div className="oi-empty" style={{ height: 72 }}>
                                No unusual OI jumps at this strike yet
                            </div>
                        )}
                    </section>
                </div>
            </aside>
        </div>
    );
};

export default StrikeDrawer;
