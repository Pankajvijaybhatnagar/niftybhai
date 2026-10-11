import React, { useMemo, useState } from "react";
import "./oiAnalytics.css";
import type { OISnapshot, OISource } from "./oiData";
import { clearHistory, expiryTime } from "./oiData";
import type { Bias, SideRate, Speed, Trend } from "./oiMath";
import {
    actionMeaning,
    bigMoneyZones,
    computeVelocity,
    detectBigPlayers,
    fmtCompact,
    fmtFull,
    fmtTime,
    etaText,
    fmtDate,
    fmtTimeSec,
    FIELD_LABEL,
    forecastCrossover,
    forecastLevelShift,
    SECOND_HIGHEST_PCT,
} from "./oiMath";
import type { LevelShift, SignalLevels } from "./oiMath";
import { strikeRoles } from "./oiMath";
import type { ForecastOverlay } from "./OICharts";
import { BigPlayerScatter, CE_COLOR, Legend, PE_COLOR, StrikeBarChart, TimeLineChart } from "./OICharts";
import type { TimeRange } from "./oiDaily";
import { isDailyRange, rangeDays, seriesForRange, TIME_RANGES, useDailyHistory } from "./oiDaily";

const WINDOWS = [1, 3, 5, 15, 30];
const RANGES = [8, 12, 20];

const rateText = (n: number) => `${fmtCompact(n, true)}/min`;

function SpeedMeter({ speed }: { speed: Speed }) {
    const level = speed === "Fast" ? 3 : speed === "Normal" ? 2 : speed === "Slow" ? 1 : 0;
    return (
        <span className="oi-speed">
            <span className="oi-meter" aria-hidden="true">
                {[1, 2, 3].map((n) => (
                    <span key={n} className={n <= level ? "on" : ""} />
                ))}
            </span>
            {speed}
        </span>
    );
}

function TrendText({ trend }: { trend: Trend }) {
    if (trend === "-") return <span className="oi-muted">-</span>;
    const icon = trend === "Accelerating" ? "↗" : trend === "Slowing" ? "↘" : "→";
    return (
        <span>
            {icon} {trend}
        </span>
    );
}

function BiasBadge({ bias }: { bias: Bias }) {
    const icon = bias === "Bullish" ? "▲" : bias === "Bearish" ? "▼" : "●";
    return (
        <span className={`oi-bias oi-bias-${bias.toLowerCase()}`}>
            <span aria-hidden="true">{icon}</span> {bias}
        </span>
    );
}

function SideKey({ side }: { side: "CE" | "PE" }) {
    return (
        <span className="oi-side">
            <span className="oi-side-key" style={{ background: side === "CE" ? CE_COLOR : PE_COLOR }} />
            {side}
        </span>
    );
}

function PaceTile({ label, side, rate, windowMin }: { label: string; side: "CE" | "PE"; rate: SideRate | null; windowMin: number }) {
    return (
        <div className="oi-tile">
            <div className="oi-tile-label">
                <SideKey side={side} /> {label}
            </div>
            <div className="oi-tile-value">{rate ? rateText(rate.rate) : "-"}</div>
            <div className="oi-tile-sub">
                {rate ? `${fmtCompact(rate.delta, true)} in last ${windowMin}m` : "Waiting for a second update"}
            </div>
            {rate && (
                <div className="oi-tile-foot">
                    <SpeedMeter speed={rate.speed} />
                    <TrendText trend={rate.trend} />
                </div>
            )}
        </div>
    );
}

interface Props {
    source: OISource | null;
    history: OISnapshot[];
    onOpenStrike?: (strike: number) => void;
    levels?: SignalLevels | null;
}

function ShiftPanel({ shift, onOpenStrike }: { shift: LevelShift; onOpenStrike?: (strike: number) => void }) {
    const color = shift.field.startsWith("ce") ? CE_COLOR : PE_COLOR;
    const fc = shift.overtake;
    const goingTo = shift.challenger;

    let overlay: ForecastOverlay | null = null;
    if (fc?.ready && shift.times.length) {
        const t1 = shift.times[shift.times.length - 1];
        const perMinute = 60_000 / fc.unitMs;
        const ahead = fc.eta !== null ? Math.min(fc.eta * 1.3 + 2, 120) : CROSS_LOOKBACK;
        overlay = {
            until: t1 + ahead * fc.unitMs,
            slopes: { challenger: fc.ceRate * perMinute, line: fc.peRate * perMinute },
            cross:
                fc.crossAt !== null && fc.crossValue !== null
                    ? { t: fc.crossAt, v: fc.crossValue, label: `≈ ${fmtTime(fc.crossAt)}` }
                    : null,
        };
    }

    const tone = fc?.converging && fc.eta !== null ? "near" : fc?.ready ? "calm" : "wait";
    const open = (strike: number) =>
        onOpenStrike ? (
            <button type="button" className="oi-link" onClick={() => onOpenStrike(strike)}>
                {strike}
            </button>
        ) : (
            strike
        );

    return (
        <div className="oi-shift">
            <div className="oi-tile-label">{shift.kind} line</div>
            <div className="oi-shift-title">
                {open(shift.lineStrike)} <span className="oi-muted">· highest {FIELD_LABEL[shift.field]} nearest spot</span>
            </div>

            {goingTo === null || shift.pct === null ? (
                <div className="oi-empty" style={{ height: 120 }}>
                    {shift.note}
                </div>
            ) : (
                <>
                    <div className="oi-shift-sub">
                        Runner-up {open(goingTo)} is at <strong>{(shift.pct * 100).toFixed(1)}%</strong> of the max
                        {shift.pct >= SECOND_HIGHEST_PCT
                            ? " - already your second highest (78%+)"
                            : ` - needs ${(SECOND_HIGHEST_PCT * 100).toFixed(0)}% to count as second highest`}
                    </div>

                    <div className={`sd-cross-status sd-cross-${tone}`}>
                        <span aria-hidden="true">{tone === "near" ? "⇄" : tone === "calm" ? "⇉" : "…"}</span>
                        {fc?.status}
                    </div>

                    <TimeLineChart
                        times={shift.times}
                        series={[
                            { key: "line", label: `${shift.lineStrike}`, color, values: shift.lineValues },
                            { key: "challenger", label: `${goingTo}`, color: "var(--oi-series-neutral)", values: shift.challengerValues },
                        ]}
                        forecast={overlay}
                        markers={(fc?.pastCrosses ?? []).map((c) => ({
                            t: c.t,
                            v: c.value,
                            label: `Lead changed at ${fmtTimeSec(c.t)}`,
                        }))}
                        height={200}
                        ariaLabel={`${FIELD_LABEL[shift.field]} at ${shift.lineStrike} versus ${goingTo}, with forecast`}
                    />

                    <div className="sd-cross-facts">
                        <div>
                            <span>Share of max</span>
                            <strong>{(shift.pct * 100).toFixed(1)}%</strong>
                        </div>
                        <div>
                            <span>Share change / min</span>
                            <strong>
                                {shift.pctRate === null
                                    ? "-"
                                    : `${shift.pctRate >= 0 ? "+" : ""}${(shift.pctRate * 100).toFixed(2)} pts`}
                            </strong>
                        </div>
                        <div>
                            <span>Reaches 78%</span>
                            <strong>
                                {shift.pct >= SECOND_HIGHEST_PCT
                                    ? "Already"
                                    : shift.reach78
                                        ? `${fmtTime(shift.reach78.at)} (~${Math.max(1, Math.round(shift.reach78.eta))}m)`
                                        : "Not on current trend"}
                            </strong>
                        </div>
                        <div>
                            <span>Overtakes</span>
                            <strong>
                                {fc?.crossAt != null && !fc.afterClose
                                    ? `${fmtTime(fc.crossAt)} (${etaText(fc)})`
                                    : "Not on current trend"}
                            </strong>
                        </div>
                    </div>

                    <p className="sd-cross-note">
                        If {goingTo} overtakes, your {shift.kind.toLowerCase()} line moves {shift.lineStrike} → {goingTo} and{" "}
                        {shift.kind === "Support" ? "CALL BUY" : "PUT BUY"} is recalculated from that strike.
                    </p>
                </>
            )}
        </div>
    );
}

const CROSS_LOOKBACK = 15;
const RECENT_CROSS_MS = 30 * 60_000;
const RECENT_CROSS_DAILY_MS = 3 * 86_400_000;

const OIAnalytics: React.FC<Props> = ({ source, history, onOpenStrike, levels }) => {
    const [windowMin, setWindowMin] = useState(5);
    const [range, setRange] = useState(12);
    const [timeRange, setTimeRange] = useState<TimeRange>("1D");

    const spot = source?.spot ?? 0;

    // strikes on screen: `range` either side of the one nearest spot
    const visibleRows = useMemo(() => {
        if (!source) return [];
        const sorted = [...source.rows].sort((a, b) => a.strike - b.strike);
        let atm = 0;
        sorted.forEach((r, i) => {
            if (Math.abs(r.strike - source.spot) < Math.abs(sorted[atm].strike - source.spot)) atm = i;
        });
        return sorted.slice(Math.max(0, atm - range), atm + range + 1);
    }, [source, range]);

    const velocity = useMemo(() => computeVelocity(history, windowMin), [history, windowMin]);
    const big = useMemo(() => detectBigPlayers(history), [history]);
    const zones = useMemo(() => bigMoneyZones(big.events), [big]);

    // time-range charts: live snapshots for 1H / 1D, daily closes for 1W / 1M
    const daily = isDailyRange(timeRange);
    const expiryAt = source ? expiryTime(source.id) : null;
    const dailyHistory = useDailyHistory(source, rangeDays(timeRange), daily);
    const ranged = useMemo(
        () => seriesForRange(timeRange, history, dailyHistory.snapshots),
        [timeRange, history, dailyHistory.snapshots]
    );

    // CE vs PE OI crossover forecast for every visible strike: imminent
    // crossings first, then recent ones, then the strikes where the lines are closest
    const crossWatch = useMemo(() => {
        const wanted = new Set(visibleRows.map((r) => r.strike));
        const lines = new Map<number, { times: number[]; ce: number[]; pe: number[] }>();
        for (const snap of ranged) {
            for (const r of snap.rows) {
                if (!wanted.has(r.strike)) continue;
                const line = lines.get(r.strike) ?? { times: [], ce: [], pe: [] };
                line.times.push(snap.t);
                line.ce.push(r.ceOI);
                line.pe.push(r.peOI);
                lines.set(r.strike, line);
            }
        }

        const now = ranged[ranged.length - 1]?.t ?? 0;
        const recentMs = daily ? RECENT_CROSS_DAILY_MS : RECENT_CROSS_MS;
        const rank = (fc: ReturnType<typeof forecastCrossover>) => {
            if (fc.crossAt !== null && !fc.afterClose) return 0;
            const lastCross = fc.pastCrosses[fc.pastCrosses.length - 1];
            if (lastCross && now - lastCross.t <= recentMs) return 1;
            return 2;
        };

        return [...lines.entries()]
            .map(([strike, l]) => {
                const fc = forecastCrossover(l.times, l.ce, l.pe, CROSS_LOOKBACK, { daily, expiryAt });
                const last = l.times.length - 1;
                const closeness = Math.abs(fc.gap) / Math.max(1, l.ce[last] + l.pe[last]);
                return { strike, fc, closeness, rank: rank(fc) };
            })
            .sort(
                (a, b) =>
                    a.rank - b.rank ||
                    (a.rank === 0 ? (a.fc.eta ?? 0) - (b.fc.eta ?? 0) : 0) ||
                    a.closeness - b.closeness
            )
            .slice(0, 10);
    }, [ranged, visibleRows, daily, expiryAt]);

    // will your support / resistance line move to another strike? (today's live updates)
    const shifts = useMemo(() => {
        if (!levels) return [];
        const out: LevelShift[] = [];
        if (levels.supportStrike !== null && levels.supportField) {
            out.push(forecastLevelShift("Support", levels.supportField, levels.supportStrike, history, CROSS_LOOKBACK, expiryAt));
        }
        if (levels.resistanceStrike !== null && levels.resistanceField) {
            out.push(
                forecastLevelShift("Resistance", levels.resistanceField, levels.resistanceStrike, history, CROSS_LOOKBACK, expiryAt)
            );
        }
        return out;
    }, [levels, history, expiryAt]);

    const pcrOf = (s: OISnapshot) => (s.totals.ceOI ? s.totals.peOI / s.totals.ceOI : 0);

    // intraday plots "OI added today"; across days the running total is what matters
    const series = useMemo(
        () => ({
            times: ranged.map((s) => s.t),
            ce: ranged.map((s) => (daily ? s.totals.ceOI : s.totals.ceChg)),
            pe: ranged.map((s) => (daily ? s.totals.peOI : s.totals.peChg)),
            pcr: ranged.map(pcrOf),
        }),
        [ranged, daily]
    );

    // the big-player map always works on today's live updates
    const live = useMemo(
        () => ({ times: history.map((s) => s.t), spots: history.map((s) => s.spot) }),
        [history]
    );

    const velocityBars = useMemo(() => {
        const byStrike = new Map(velocity.strikes.map((v) => [v.strike, v]));
        return visibleRows
            .filter((r) => byStrike.has(r.strike))
            .map((r) => {
                const v = byStrike.get(r.strike)!;
                return { strike: r.strike, ce: v.ce.rate, pe: v.pe.rate };
            });
    }, [velocity, visibleRows]);

    const movers = useMemo(
        () =>
            velocity.strikes
                .flatMap((v) => [
                    { strike: v.strike, side: "CE" as const, rate: v.ce },
                    { strike: v.strike, side: "PE" as const, rate: v.pe },
                ])
                .filter((m) => m.rate.delta !== 0)
                .sort((a, b) => Math.abs(b.rate.rate) - Math.abs(a.rate.rate))
                .slice(0, 8),
        [velocity]
    );

    if (!source) return null;

    const totals = velocity.totals;
    const first = history[0];
    const last = history[history.length - 1];
    const pcrNow = last ? pcrOf(last) : 0;
    const pcrStart = first ? pcrOf(first) : 0;
    const pcrDelta = Math.round((pcrNow - pcrStart) * 100) / 100 || 0;

    let fasterText = "Waiting for more updates";
    if (totals) {
        const ce = Math.abs(totals.ce.rate);
        const pe = Math.abs(totals.pe.rate);
        if (ce === 0 && pe === 0) fasterText = "No OI change in this window";
        else {
            const fastSide = pe >= ce ? "PE" : "CE";
            const fast = fastSide === "PE" ? totals.pe : totals.ce;
            const ratio = Math.max(ce, pe) / Math.max(1, Math.min(ce, pe));
            const verb = fast.rate >= 0 ? "building" : "unwinding";
            fasterText =
                Math.min(ce, pe) === 0
                    ? `Only ${fastSide} OI is moving (${verb})`
                    : `${fastSide} OI ${verb} ${ratio.toFixed(1)}x faster`;
        }
    }

    const pcrReading = pcrNow >= 1.2 ? "Put-heavy" : pcrNow > 0 && pcrNow <= 0.8 ? "Call-heavy" : "Balanced";
    const recentBig = big.events.filter((e) => last && e.t >= last.t - windowMin * 60_000).length;

    return (
        <section className="oi-viz oi-theme">
            <div className="oi-head">
                <div>
                    <h3 className="oi-title">OI Analytics</h3>
                    <div className="oi-subtitle">
                        {first
                            ? `Tracking ${history.length} updates since ${fmtTime(first.t)} · last ${fmtTimeSec(last.t)}`
                            : "Waiting for the first live update"}
                    </div>
                </div>
                <div className="oi-head-actions">
                    <button
                        type="button"
                        className="oi-btn"
                        onClick={() => {
                            if (window.confirm("Clear today's tracked OI history for this instrument?")) {
                                clearHistory(source.id);
                            }
                        }}
                    >
                        Reset history
                    </button>
                </div>
            </div>

            <>
                    <div className="oi-controls">
                        <div className="oi-seg" role="group" aria-label="Rate window">
                            <span className="oi-seg-label">Rate window</span>
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
                        <div className="oi-seg" role="group" aria-label="Time range">
                            <span className="oi-seg-label">Time range</span>
                            {TIME_RANGES.map((r) => (
                                <button
                                    key={r}
                                    type="button"
                                    className={r === timeRange ? "active" : ""}
                                    aria-pressed={r === timeRange}
                                    onClick={() => setTimeRange(r)}
                                >
                                    {r}
                                </button>
                            ))}
                        </div>
                        <div className="oi-seg" role="group" aria-label="Strikes around spot">
                            <span className="oi-seg-label">Strikes</span>
                            {RANGES.map((r) => (
                                <button
                                    key={r}
                                    type="button"
                                    className={r === range ? "active" : ""}
                                    aria-pressed={r === range}
                                    onClick={() => setRange(r)}
                                >
                                    ±{r}
                                </button>
                            ))}
                        </div>
                    </div>

                    {totals && !totals.ready && (
                        <div className="oi-notice">
                            Speed labels need about {windowMin * 2} minutes of live data for a {windowMin}m window. Rates
                            shown now use the {totals.spanMin.toFixed(1)} minutes collected so far.
                        </div>
                    )}

                    <div className="oi-tiles">
                        <PaceTile label="OI pace" side="CE" rate={totals?.ce ?? null} windowMin={windowMin} />
                        <PaceTile label="OI pace" side="PE" rate={totals?.pe ?? null} windowMin={windowMin} />
                        <div className="oi-tile">
                            <div className="oi-tile-label">Who is faster</div>
                            <div className="oi-tile-value oi-tile-value-sm">{fasterText}</div>
                            <div className="oi-tile-sub">
                                PCR {pcrNow.toFixed(2)} · {pcrReading}
                                {history.length > 1 && ` · ${pcrDelta >= 0 ? "+" : ""}${pcrDelta.toFixed(2)} since ${fmtTime(first.t)}`}
                            </div>
                        </div>
                        <div className="oi-tile">
                            <div className="oi-tile-label">Big-player entries</div>
                            <div className="oi-tile-value">{big.ready ? big.events.length : "-"}</div>
                            <div className="oi-tile-sub">
                                {big.ready
                                    ? `${recentBig} in last ${windowMin}m · trigger ≥ ${fmtCompact(big.threshold)} per update`
                                    : "Learning normal update size"}
                            </div>
                        </div>
                    </div>

                    {shifts.length > 0 && (
                        <div className="oi-card oi-card-solo">
                            <div className="oi-card-head">
                                <div>
                                    <h4>Support / resistance shift forecast</h4>
                                    <p>
                                        Uses the option chain's own rules: the line is the highest cell of the winning column, and
                                        the runner-up counts as second highest at 78%. Forecast from the last {CROSS_LOOKBACK} min
                                        of today's live updates.
                                    </p>
                                </div>
                            </div>
                            <div className="oi-shifts">
                                {shifts.map((sh) => (
                                    <ShiftPanel key={sh.kind} shift={sh} onOpenStrike={onOpenStrike} />
                                ))}
                            </div>
                        </div>
                    )}

                    <div className="oi-card oi-card-solo">
                        <div className="oi-card-head">
                            <div>
                                <h4>Crossover watch - CE vs PE OI by strike</h4>
                                <p>
                                    Which strikes' CE and PE OI lines are about to cross,{" "}
                                    {daily
                                        ? `based on each strike's daily closing OI over ${timeRange}`
                                        : `based on the last ${CROSS_LOOKBACK} min trend`}
                                    . Click a row to open its line chart with the forecast.
                                </p>
                            </div>
                        </div>
                        {dailyHistory.loading && <div className="oi-notice">Loading daily OI from NSE...</div>}
                        {dailyHistory.error && (
                            <div className="oi-notice">Some days could not be loaded: {dailyHistory.error}</div>
                        )}
                        {crossWatch.length && ranged.length > 1 ? (
                            <div className="oi-table-wrap">
                                <table className="oi-table">
                                    <thead>
                                        <tr>
                                            <th>Strike</th>
                                            <th>Role</th>
                                            <th>On top now</th>
                                            <th className="num">Gap</th>
                                            <th className="num">Gap / {daily ? "day" : "min"}</th>
                                            <th>Forecast</th>
                                            <th>Confidence</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {crossWatch.map(({ strike, fc, rank }) => {
                                            const lastCross = fc.pastCrosses[fc.pastCrosses.length - 1];
                                            const forecastText =
                                                rank === 0 && fc.nextAbove && fc.crossAt !== null
                                                    ? `⇄ ${fc.nextAbove} may cross above ${fc.nextAbove === "CE" ? "PE" : "CE"} in ${etaText(fc)} (≈ ${daily ? fmtDate(fc.crossAt) : fmtTime(fc.crossAt)})`
                                                    : rank === 1 && lastCross
                                                        ? `✕ Crossed ${daily ? `on ${fmtDate(lastCross.t)}` : `at ${fmtTime(lastCross.t)}`} - ${lastCross.above} now on top`
                                                        : fc.status;
                                            return (
                                                <tr
                                                    key={strike}
                                                    className={onOpenStrike ? "oi-cross-row" : undefined}
                                                    tabIndex={onOpenStrike ? 0 : undefined}
                                                    onClick={() => onOpenStrike?.(strike)}
                                                    onKeyDown={(e) => {
                                                        if (e.key === "Enter") onOpenStrike?.(strike);
                                                    }}
                                                >
                                                    <td className="num">
                                                        <strong>{strike}</strong>
                                                    </td>
                                                    <td>
                                                        {strikeRoles(strike, levels).map((r) => (
                                                            <span key={r} className="oi-role">
                                                                {r}
                                                            </span>
                                                        ))}
                                                    </td>
                                                    <td>
                                                        {fc.leader === "Equal" ? "Level" : <SideKey side={fc.leader} />}
                                                    </td>
                                                    <td className="num">{fmtCompact(Math.abs(fc.gap))}</td>
                                                    <td className="num">
                                                        {fc.ready
                                                            ? `${fmtCompact(Math.abs(fc.gapRate))} ${fc.converging ? "closing" : "widening"}`
                                                            : "-"}
                                                    </td>
                                                    <td className={rank === 0 ? "oi-cross-hot" : undefined}>{forecastText}</td>
                                                    <td>{fc.ready ? fc.confidence : "-"}</td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        ) : (
                            <div className="oi-empty" style={{ height: 96 }}>
                                Collecting data - the crossover forecast starts after a few minutes of live updates
                            </div>
                        )}
                    </div>

                    <div className="oi-cards">
                        <div className="oi-card">
                            <div className="oi-card-head">
                                <div>
                                    <h4>Open interest by strike</h4>
                                    <p>Where positions are parked right now - tall CE bars cap the upside, tall PE bars hold the downside</p>
                                </div>
                                <Legend items={[{ label: "CE OI", color: CE_COLOR }, { label: "PE OI", color: PE_COLOR }]} />
                            </div>
                            <StrikeBarChart
                                data={visibleRows.map((r) => ({ strike: r.strike, ce: r.ceOI, pe: r.peOI }))}
                                spot={spot}
                                ariaLabel="Call and put open interest by strike"
                            />
                        </div>

                        <div className="oi-card">
                            <div className="oi-card-head">
                                <div>
                                    <h4>Change in OI today by strike</h4>
                                    <p>Fresh positions added (up) or cut (down) since the previous session</p>
                                </div>
                                <Legend items={[{ label: "CE Chg", color: CE_COLOR }, { label: "PE Chg", color: PE_COLOR }]} />
                            </div>
                            <StrikeBarChart
                                data={visibleRows.map((r) => ({ strike: r.strike, ce: r.ceChg, pe: r.peChg }))}
                                spot={spot}
                                tipFormat={(n) => `${n > 0 ? "+" : ""}${fmtFull(n)}`}
                                ariaLabel="Change in call and put open interest by strike"
                            />
                        </div>

                        <div className="oi-card">
                            <div className="oi-card-head">
                                <div>
                                    <h4>OI rate of change by strike</h4>
                                    <p>Contracts per minute over the last {windowMin}m - the tallest bars are where OI is moving fastest</p>
                                </div>
                                <Legend items={[{ label: "CE /min", color: CE_COLOR }, { label: "PE /min", color: PE_COLOR }]} />
                            </div>
                            <StrikeBarChart
                                data={velocityBars}
                                spot={spot}
                                tipFormat={rateText}
                                ariaLabel={`Open interest change per minute by strike over the last ${windowMin} minutes`}
                                emptyText="Collecting data - rates appear after the second live update"
                            />
                        </div>

                        <div className="oi-card">
                            <div className="oi-card-head">
                                <div>
                                    <h4>{daily ? `Total OI by day (${timeRange})` : `OI added today (${timeRange})`}</h4>
                                    <p>
                                        {daily
                                            ? "Total CE vs PE OI across the chain at each day's close - the steeper line is the side building faster"
                                            : "Total change in OI across the chain - the steeper line is the side adding faster"}
                                    </p>
                                </div>
                                <Legend
                                    items={[
                                        { label: daily ? "CE OI" : "CE added", color: CE_COLOR, kind: "line" },
                                        { label: daily ? "PE OI" : "PE added", color: PE_COLOR, kind: "line" },
                                    ]}
                                />
                            </div>
                            <TimeLineChart
                                times={series.times}
                                series={[
                                    { key: "ce", label: "CE", color: CE_COLOR, values: series.ce },
                                    { key: "pe", label: "PE", color: PE_COLOR, values: series.pe },
                                ]}
                                zeroLine={!daily}
                                ariaLabel={daily ? "Total call and put OI by day" : "Total call and put OI added today, over time"}
                            />
                        </div>

                        <div className="oi-card">
                            <div className="oi-card-head">
                                <div>
                                    <h4>Put-call ratio ({timeRange})</h4>
                                    <p>Total PE OI ÷ total CE OI - rising means puts are being added faster than calls</p>
                                </div>
                            </div>
                            <TimeLineChart
                                times={series.times}
                                series={[{ key: "pcr", label: "PCR", color: "var(--oi-series-neutral)", values: series.pcr }]}
                                format={(n) => n.toFixed(2)}
                                tipFormat={(n) => n.toFixed(3)}
                                ariaLabel="Put-call ratio over time"
                            />
                        </div>

                        <div className="oi-card">
                            <div className="oi-card-head">
                                <div>
                                    <h4>Fastest moving OI</h4>
                                    <p>
                                        Last {windowMin}m. Speed compares each strike with its own pace for the session.
                                    </p>
                                </div>
                            </div>
                            {movers.length ? (
                                <div className="oi-table-wrap">
                                    <table className="oi-table">
                                        <thead>
                                            <tr>
                                                <th>Strike</th>
                                                <th>Side</th>
                                                <th className="num">OI change</th>
                                                <th className="num">Rate</th>
                                                <th>Speed</th>
                                                <th>Trend</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {movers.map((m) => (
                                                <tr key={`${m.side}${m.strike}`}>
                                                    <td className="num">{m.strike}</td>
                                                    <td><SideKey side={m.side} /></td>
                                                    <td className="num">{fmtCompact(m.rate.delta, true)}</td>
                                                    <td className="num">{rateText(m.rate.rate)}</td>
                                                    <td><SpeedMeter speed={m.rate.speed} /></td>
                                                    <td><TrendText trend={m.rate.trend} /></td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            ) : (
                                <div className="oi-empty" style={{ height: 160 }}>
                                    No OI movement in this window yet
                                </div>
                            )}
                        </div>

                        <div className="oi-card oi-card-wide">
                            <div className="oi-card-head">
                                <div>
                                    <h4>Where big players are entering</h4>
                                    <p>
                                        {daily && "Today's live updates (not affected by the time range). "}
                                        Each dot is an unusually large OI jump in a single update (5x+ the normal size). Bigger dot = more
                                        unusual. The grey line is spot.
                                    </p>
                                </div>
                                <Legend
                                    items={[
                                        { label: "CE added", color: CE_COLOR, kind: "dot" },
                                        { label: "PE added", color: PE_COLOR, kind: "dot" },
                                        { label: "CE cut", color: CE_COLOR, kind: "ring" },
                                        { label: "PE cut", color: PE_COLOR, kind: "ring" },
                                        { label: "Spot", color: "var(--oi-spot)", kind: "line" },
                                    ]}
                                />
                            </div>

                            {zones.length > 0 && (
                                <div className="oi-zones">
                                    <span className="oi-seg-label">Heaviest fresh entries</span>
                                    {zones.map((z) => (
                                        <span key={`${z.side}${z.strike}`} className="oi-zone">
                                            <SideKey side={z.side} />
                                            <strong>{z.strike}</strong>
                                            {fmtCompact(z.added, true)} in {z.count} {z.count === 1 ? "jump" : "jumps"} ·{" "}
                                            {actionMeaning(z.side, z.lastAction)}
                                        </span>
                                    ))}
                                </div>
                            )}

                            <BigPlayerScatter events={big.events} times={live.times} spots={live.spots} />

                            {big.events.length > 0 && (
                                <div className="oi-table-wrap">
                                    <table className="oi-table">
                                        <thead>
                                            <tr>
                                                <th>Time</th>
                                                <th>Strike</th>
                                                <th>Side</th>
                                                <th className="num">OI change</th>
                                                <th className="num">Premium</th>
                                                <th className="num">Size</th>
                                                <th>Reading</th>
                                                <th>Bias</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {big.events.slice(0, 12).map((e) => (
                                                <tr key={`${e.t}-${e.strike}-${e.side}`}>
                                                    <td className="num">{fmtTimeSec(e.t)}</td>
                                                    <td className="num">{e.strike}</td>
                                                    <td><SideKey side={e.side} /></td>
                                                    <td className="num">{fmtCompact(e.dOI, true)}</td>
                                                    <td className="num">
                                                        {e.dLTP > 0 ? "+" : ""}
                                                        {e.dLTP.toFixed(2)}
                                                    </td>
                                                    <td className="num">{e.multiple.toFixed(1)}x</td>
                                                    <td>
                                                        <strong>{e.action}</strong>
                                                        <span className="oi-muted"> · {actionMeaning(e.side, e.action)}</span>
                                                    </td>
                                                    <td><BiasBadge bias={e.bias} /></td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </div>
                    </div>

                    <details className="oi-help">
                        <summary>How these are calculated</summary>
                        <ul>
                            <li>
                                Every live refresh that changes the chain is saved as a snapshot for today (in this browser), so the
                                history survives a page reload.
                            </li>
                            <li>
                                <strong>Rate</strong> = OI now minus OI at the start of the window, divided by minutes.{" "}
                                <strong>Speed</strong> compares that rate with the series' own average pace this session: Fast ≥ 1.5x,
                                Slow ≤ 0.5x. <strong>Trend</strong> compares this window with the window before it.
                            </li>
                            <li>
                                <strong>Big-player entry</strong> = an OI change in one update that is at least 5x the median update
                                size and in the top 5% of all updates this session. The premium move in the same update tells who
                                acted: OI up + premium up = buyers (long buildup), OI up + premium down = writers (short buildup), OI
                                down + premium up = short covering, OI down + premium down = long unwinding.
                            </li>
                            <li>These are heuristics on public OI data, not a confirmed identity of any trader.</li>
                        </ul>
                    </details>
            </>
        </section>
    );
};

export default OIAnalytics;
