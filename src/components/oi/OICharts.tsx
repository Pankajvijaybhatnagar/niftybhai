import React, { useLayoutEffect, useRef, useState } from "react";
import type { BigEvent } from "./oiMath";
import { actionMeaning, fmtCompact, fmtDate, fmtFull, fmtTime, fmtTimeSec } from "./oiMath";

// Hand-rolled SVG charts so no chart library is needed. Colors come from the
// CSS tokens in oiAnalytics.css, so light and dark mode both work.

export const CE_COLOR = "var(--oi-ce)";
export const PE_COLOR = "var(--oi-pe)";

function useWidth() {
    const ref = useRef<HTMLDivElement>(null);
    const [width, setWidth] = useState(0);

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        setWidth(el.clientWidth);
        const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    return [ref, width] as const;
}

function niceScale(lo: number, hi: number, count = 4) {
    if (lo === hi) {
        const pad = Math.abs(lo) * 0.05 || 1;
        lo -= pad;
        hi += pad;
    }
    const raw = (hi - lo) / count;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const n = raw / mag;
    const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
    const min = Math.floor(lo / step) * step;
    const max = Math.ceil(hi / step) * step;
    const ticks: number[] = [];
    for (let v = min; v <= max + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
    return { min, max, ticks };
}

/** Bar with a 4px rounded data end, square at the baseline. */
function barPath(x: number, w: number, y0: number, y1: number) {
    const h = Math.abs(y1 - y0);
    if (h < 0.5) return "";
    const r = Math.min(4, w / 2, h);
    if (y1 < y0) {
        return `M${x},${y0}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 + r}V${y0}Z`;
    }
    return `M${x},${y0}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 - r}V${y0}Z`;
}

interface TipRow {
    color?: string;
    label: string;
    value: string;
}

interface Tip {
    x: number;
    y: number;
    title: string;
    rows: TipRow[];
    note?: string;
}

function Tooltip({ tip, width }: { tip: Tip | null; width: number }) {
    if (!tip) return null;
    const flip = tip.x > width / 2;
    return (
        <div
            className="oi-tip"
            style={{
                top: tip.y,
                left: flip ? undefined : tip.x + 14,
                right: flip ? width - tip.x + 14 : undefined,
            }}
        >
            <div className="oi-tip-title">{tip.title}</div>
            {tip.rows.map((r) => (
                <div className="oi-tip-row" key={r.label}>
                    {r.color && <span className="oi-tip-key" style={{ background: r.color }} />}
                    <strong>{r.value}</strong>
                    <span>{r.label}</span>
                </div>
            ))}
            {tip.note && <div className="oi-tip-note">{tip.note}</div>}
        </div>
    );
}

export function Legend({ items }: { items: { label: string; color: string; kind?: "bar" | "line" | "dot" | "ring" }[] }) {
    return (
        <div className="oi-legend">
            {items.map((it) => (
                <span key={it.label} className="oi-legend-item">
                    <span
                        className={`oi-swatch oi-swatch-${it.kind ?? "bar"}`}
                        style={it.kind === "ring" ? { borderColor: it.color } : { background: it.color }}
                    />
                    {it.label}
                </span>
            ))}
        </div>
    );
}

const Empty = ({ height, text }: { height: number; text: string }) => (
    <div className="oi-empty" style={{ height }}>
        {text}
    </div>
);

// =========================
// Grouped CE / PE columns per strike, with a spot marker.
// =========================
export interface StrikeDatum {
    strike: number;
    ce: number;
    pe: number;
}

interface StrikeBarProps {
    data: StrikeDatum[];
    spot: number;
    format?: (n: number) => string;
    tipFormat?: (n: number) => string;
    height?: number;
    ariaLabel: string;
    emptyText?: string;
    highlightStrike?: number;
}

export function StrikeBarChart({
    data,
    spot,
    format = (n) => fmtCompact(n),
    tipFormat = fmtFull,
    height = 240,
    ariaLabel,
    emptyText = "No data yet",
    highlightStrike,
}: StrikeBarProps) {
    const [ref, measured] = useWidth();
    const [hover, setHover] = useState<number | null>(null);

    const width = Math.max(measured, 280);
    const M = { l: 52, r: 12, t: 32, b: 30 };
    const plotW = width - M.l - M.r;
    const plotH = height - M.t - M.b;

    if (!data.length) {
        return (
            <div ref={ref} className="oi-chart">
                <Empty height={height} text={emptyText} />
            </div>
        );
    }

    const values = data.flatMap((d) => [d.ce, d.pe]);
    const { min, max, ticks } = niceScale(Math.min(0, ...values), Math.max(0, ...values));
    const y = (v: number) => M.t + ((max - v) / (max - min)) * plotH;
    const y0 = y(0);

    const band = plotW / data.length;
    const barW = Math.max(2, Math.min(24, (band - 8) / 2));
    const pairW = barW * 2 + 2;
    const center = (i: number) => M.l + band * (i + 0.5);
    const labelEvery = Math.max(1, Math.ceil(46 / band));
    const highlightIdx = data.findIndex((d) => d.strike === highlightStrike);

    // spot position, interpolated between the strikes around it
    let spotX: number | null = null;
    for (let i = 0; i < data.length - 1; i++) {
        const a = data[i].strike;
        const b = data[i + 1].strike;
        if (spot >= a && spot <= b) {
            spotX = center(i) + ((spot - a) / (b - a)) * band;
            break;
        }
    }

    // direct labels only on the biggest CE and PE bars
    const argMax = (key: "ce" | "pe") =>
        data.reduce((best, d, i) => (Math.abs(d[key]) > Math.abs(data[best][key]) ? i : best), 0);
    const maxCe = argMax("ce");
    const maxPe = argMax("pe");

    const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
        const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
        const i = Math.floor((px - M.l) / band);
        setHover(i >= 0 && i < data.length ? i : null);
    };

    const onKey = (e: React.KeyboardEvent<SVGSVGElement>) => {
        if (e.key === "ArrowRight") setHover((h) => Math.min(data.length - 1, (h ?? -1) + 1));
        if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? data.length) - 1));
    };

    const tip: Tip | null =
        hover === null
            ? null
            : {
                x: center(hover),
                y: M.t,
                title: `Strike ${data[hover].strike}`,
                rows: [
                    { color: CE_COLOR, label: "CE", value: tipFormat(data[hover].ce) },
                    { color: PE_COLOR, label: "PE", value: tipFormat(data[hover].pe) },
                ],
            };

    return (
        <div ref={ref} className="oi-chart">
            <svg
                width={width}
                height={height}
                role="img"
                aria-label={ariaLabel}
                tabIndex={0}
                onPointerMove={onMove}
                onPointerLeave={() => setHover(null)}
                onKeyDown={onKey}
                onBlur={() => setHover(null)}
            >
                {ticks.map((t) => (
                    <g key={t}>
                        <line className={t === 0 ? "oi-baseline" : "oi-grid"} x1={M.l} x2={width - M.r} y1={y(t)} y2={y(t)} />
                        <text className="oi-axis-text" x={M.l - 6} y={y(t)} dy="0.32em" textAnchor="end">
                            {format(t)}
                        </text>
                    </g>
                ))}

                {highlightIdx >= 0 && (
                    <rect className="oi-highlight-band" x={M.l + band * highlightIdx} y={M.t} width={band} height={plotH} rx={4} />
                )}

                {hover !== null && (
                    <rect className="oi-hover-band" x={M.l + band * hover} y={M.t} width={band} height={plotH} />
                )}

                {data.map((d, i) => {
                    const x = center(i) - pairW / 2;
                    return (
                        <g key={d.strike}>
                            <path d={barPath(x, barW, y0, y(d.ce))} style={{ fill: CE_COLOR }} />
                            <path d={barPath(x + barW + 2, barW, y0, y(d.pe))} style={{ fill: PE_COLOR }} />
                            {(i === highlightIdx ||
                                (i % labelEvery === 0 && (highlightIdx < 0 || Math.abs(i - highlightIdx) >= labelEvery))) && (
                                <text
                                    className={i === highlightIdx ? "oi-axis-text oi-axis-strong" : "oi-axis-text"}
                                    x={center(i)} y={height - M.b + 16} textAnchor="middle">
                                    {d.strike}
                                </text>
                            )}
                        </g>
                    );
                })}

                {[
                    { i: maxCe, v: data[maxCe].ce, x: center(maxCe) - pairW / 2 + barW / 2 },
                    { i: maxPe, v: data[maxPe].pe, x: center(maxPe) - pairW / 2 + barW * 1.5 + 2 },
                ]
                    .filter((l) => l.v !== 0)
                    .map((l, k) => (
                        <text
                            key={k}
                            className="oi-value-label"
                            x={l.x}
                            y={l.v > 0 ? y(l.v) - 5 : y(l.v) + 12}
                            textAnchor="middle"
                        >
                            {format(l.v)}
                        </text>
                    ))}

                {spotX !== null && (
                    <g>
                        <line className="oi-spot-line" x1={spotX} x2={spotX} y1={17} y2={M.t + plotH} />
                        <text className="oi-spot-text" x={spotX} y={12} textAnchor="middle">
                            Spot {fmtFull(Number(spot.toFixed(2)))}
                        </text>
                    </g>
                )}
            </svg>
            <Tooltip tip={tip} width={width} />
        </div>
    );
}

// =========================
// Lines over time with crosshair.
// =========================
export interface LineSeries {
    key: string;
    label: string;
    color: string;
    values: number[];
}

interface TimeLineProps {
    times: number[];
    series: LineSeries[];
    format?: (n: number) => string;
    tipFormat?: (n: number) => string;
    height?: number;
    ariaLabel: string;
    zeroLine?: boolean;
    forecast?: ForecastOverlay | null;
    markers?: ChartMarker[];
}

/** Dashed projection from each series' last value, at `slope` per minute. */
export interface ForecastOverlay {
    until: number;
    slopes: Record<string, number>;
    cross?: { t: number; v: number; label: string } | null;
}

export interface ChartMarker {
    t: number;
    v: number;
    label: string;
}

function timeTicks(t0: number, t1: number, count: number) {
    const out: number[] = [];
    for (let i = 0; i <= count; i++) out.push(t0 + ((t1 - t0) * i) / count);
    return out;
}

export function TimeLineChart({
    times,
    series,
    format = (n) => fmtCompact(n),
    tipFormat = fmtFull,
    height = 220,
    ariaLabel,
    zeroLine = false,
    forecast = null,
    markers = [],
}: TimeLineProps) {
    const [ref, measured] = useWidth();
    const [hover, setHover] = useState<number | null>(null);

    const width = Math.max(measured, 280);
    const M = { l: 56, r: 76, t: 14, b: 28 };
    const plotW = width - M.l - M.r;
    const plotH = height - M.t - M.b;

    if (times.length < 2) {
        return (
            <div ref={ref} className="oi-chart">
                <Empty height={height} text="Collecting data - this fills in as live updates arrive" />
            </div>
        );
    }

    const t0 = times[0];
    const t1 = times[times.length - 1];
    const tEnd = forecast ? Math.max(t1, forecast.until) : t1;

    const lastOf = (s: LineSeries) => s.values[s.values.length - 1];
    const projected = (s: LineSeries, t: number) =>
        lastOf(s) + (forecast?.slopes[s.key] ?? 0) * ((t - t1) / 60_000);

    const all = series.flatMap((s) => s.values);
    if (forecast) {
        series.forEach((s) => all.push(projected(s, tEnd)));
        if (forecast.cross) all.push(forecast.cross.v);
    }
    const lo = Math.min(...all, ...(zeroLine ? [0] : []));
    const hi = Math.max(...all, ...(zeroLine ? [0] : []));
    const { min, max, ticks } = niceScale(lo, hi);

    const x = (t: number) => M.l + ((t - t0) / Math.max(1, tEnd - t0)) * plotW;
    const y = (v: number) => M.t + ((max - v) / (max - min)) * plotH;
    const multiDay = tEnd - t0 > 36 * 3_600_000;
    const timeFmt = multiDay ? fmtDate : tEnd - t0 < 5 * 60_000 ? fmtTimeSec : fmtTime;
    const tipTime = (t: number) => (multiDay ? `${fmtDate(t)} ${fmtTime(t)}` : fmtTimeSec(t));
    const xTicks = timeTicks(t0, tEnd, plotW > 420 ? 4 : 2);

    const path = (vals: number[]) =>
        vals.map((v, i) => `${i ? "L" : "M"}${x(times[i]).toFixed(1)},${y(v).toFixed(1)}`).join("");

    // end labels, nudged apart when they would collide
    const ends = series
        .map((s) => ({ s, y: y(forecast ? projected(s, tEnd) : lastOf(s)) }))
        .sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) {
        if (ends[i].y - ends[i - 1].y < 26) ends[i].y = ends[i - 1].y + 26;
    }

    const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
        const px = e.clientX - e.currentTarget.getBoundingClientRect().left;
        const t = t0 + ((px - M.l) / plotW) * (tEnd - t0);
        let best = 0;
        for (let i = 1; i < times.length; i++) {
            if (Math.abs(times[i] - t) < Math.abs(times[best] - t)) best = i;
        }
        setHover(best);
    };

    const onKey = (e: React.KeyboardEvent<SVGSVGElement>) => {
        if (e.key === "ArrowRight") setHover((h) => Math.min(times.length - 1, (h ?? -1) + 1));
        if (e.key === "ArrowLeft") setHover((h) => Math.max(0, (h ?? times.length) - 1));
    };

    const tip: Tip | null =
        hover === null
            ? null
            : {
                x: x(times[hover]),
                y: M.t,
                title: tipTime(times[hover]),
                rows: series.map((s) => ({ color: s.color, label: s.label, value: tipFormat(s.values[hover]) })),
            };

    return (
        <div ref={ref} className="oi-chart">
            <svg
                width={width}
                height={height}
                role="img"
                aria-label={ariaLabel}
                tabIndex={0}
                onPointerMove={onMove}
                onPointerLeave={() => setHover(null)}
                onKeyDown={onKey}
                onBlur={() => setHover(null)}
            >
                {ticks.map((t) => (
                    <g key={t}>
                        <line
                            className={t === 0 && zeroLine ? "oi-baseline" : "oi-grid"}
                            x1={M.l}
                            x2={width - M.r}
                            y1={y(t)}
                            y2={y(t)}
                        />
                        <text className="oi-axis-text" x={M.l - 6} y={y(t)} dy="0.32em" textAnchor="end">
                            {format(t)}
                        </text>
                    </g>
                ))}

                {xTicks.map((t, i) => (
                    <text
                        key={i}
                        className="oi-axis-text"
                        x={x(t)}
                        y={height - 8}
                        textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}
                    >
                        {timeFmt(t)}
                    </text>
                ))}

                {forecast && tEnd > t1 && (
                    <g>
                        <rect className="oi-forecast-band" x={x(t1)} y={M.t} width={x(tEnd) - x(t1)} height={plotH} />
                        <text className="oi-axis-text" x={x(t1) + 6} y={M.t + 12}>
                            Forecast
                        </text>
                        {series.map((s) => (
                            <line
                                key={s.key}
                                className="oi-line oi-forecast-line"
                                x1={x(t1)}
                                y1={y(lastOf(s))}
                                x2={x(tEnd)}
                                y2={y(projected(s, tEnd))}
                                style={{ stroke: s.color }}
                            />
                        ))}
                    </g>
                )}

                {series.map((s) => (
                    <path key={s.key} d={path(s.values)} className="oi-line" style={{ stroke: s.color }} />
                ))}

                {markers.map((m) => (
                    <g key={m.t}>
                        <circle className="oi-cross-marker" cx={x(m.t)} cy={y(m.v)} r={6}>
                            <title>{m.label}</title>
                        </circle>
                        <path
                            className="oi-cross-x"
                            d={`M${x(m.t) - 3},${y(m.v) - 3}l6,6m0,-6l-6,6`}
                        />
                    </g>
                ))}

                {forecast?.cross && (
                    <g>
                        <circle className="oi-cross-forecast" cx={x(forecast.cross.t)} cy={y(forecast.cross.v)} r={7} />
                        <text
                            className="oi-value-label"
                            x={x(forecast.cross.t)}
                            y={y(forecast.cross.v) - 13}
                            textAnchor="middle"
                        >
                            {forecast.cross.label}
                        </text>
                    </g>
                )}

                {hover !== null && (
                    <line className="oi-crosshair" x1={x(times[hover])} x2={x(times[hover])} y1={M.t} y2={M.t + plotH} />
                )}

                {series.map((s) => {
                    const i = hover ?? s.values.length - 1;
                    return (
                        <circle
                            key={s.key}
                            className="oi-dot"
                            cx={x(times[i])}
                            cy={y(s.values[i])}
                            r={4}
                            style={{ fill: s.color }}
                        />
                    );
                })}

                {ends.map(({ s, y: ly }) => (
                    <g key={s.key}>
                        <text className="oi-value-label" x={width - M.r + 8} y={ly} dy="0.32em">
                            {format(s.values[s.values.length - 1])}
                        </text>
                        <text className="oi-axis-text" x={width - M.r + 8} y={ly + 12} dy="0.32em">
                            {forecast ? `${s.label} now` : s.label}
                        </text>
                    </g>
                ))}
            </svg>
            <Tooltip tip={tip} width={width} />
        </div>
    );
}

// =========================
// Big-player map: time x strike, spot path drawn through it.
// Filled dot = OI added, ring = OI cut. Size = how unusual the jump was.
// =========================
interface ScatterProps {
    events: BigEvent[];
    times: number[];
    spots: number[];
    height?: number;
}

export function BigPlayerScatter({ events, times, spots, height = 280 }: ScatterProps) {
    const [ref, measured] = useWidth();
    const [hover, setHover] = useState<number | null>(null);

    const width = Math.max(measured, 280);
    const M = { l: 56, r: 16, t: 14, b: 28 };
    const plotW = width - M.l - M.r;
    const plotH = height - M.t - M.b;

    const shown = events.slice(0, 300);

    if (times.length < 2) {
        return (
            <div ref={ref} className="oi-chart">
                <Empty height={height} text="Collecting data - this fills in as live updates arrive" />
            </div>
        );
    }

    const t0 = times[0];
    const t1 = times[times.length - 1];
    const levels = [...spots, ...shown.map((e) => e.strike)];
    const { min, max, ticks } = niceScale(Math.min(...levels), Math.max(...levels));

    const x = (t: number) => M.l + ((t - t0) / Math.max(1, t1 - t0)) * plotW;
    const y = (v: number) => M.t + ((max - v) / (max - min)) * plotH;
    const r = (e: BigEvent) => Math.max(4, Math.min(10, 4 + Math.log2(e.multiple / 5 + 1) * 3));
    const timeFmt = t1 - t0 < 5 * 60_000 ? fmtTimeSec : fmtTime;
    const xTicks = timeTicks(t0, t1, plotW > 420 ? 4 : 2);

    const spotPath = spots
        .map((s, i) => `${i ? "L" : "M"}${x(times[i]).toFixed(1)},${y(s).toFixed(1)}`)
        .join("");

    const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
        const box = e.currentTarget.getBoundingClientRect();
        const px = e.clientX - box.left;
        const py = e.clientY - box.top;
        let best: number | null = null;
        let bestD = 16 * 16; // nearest dot within 16px
        shown.forEach((ev, i) => {
            const d = (x(ev.t) - px) ** 2 + (y(ev.strike) - py) ** 2;
            if (d < bestD) {
                bestD = d;
                best = i;
            }
        });
        setHover(best);
    };

    const onKey = (e: React.KeyboardEvent<SVGSVGElement>) => {
        if (!shown.length) return;
        // events are newest first; arrows walk through time
        if (e.key === "ArrowLeft") setHover((h) => Math.min(shown.length - 1, (h ?? -1) + 1));
        if (e.key === "ArrowRight") setHover((h) => Math.max(0, (h ?? shown.length) - 1));
    };

    const ev = hover === null ? null : shown[hover] ?? null;
    const tip: Tip | null = ev
        ? {
            x: x(ev.t),
            y: Math.max(M.t, y(ev.strike) - 40),
            title: `${ev.strike} ${ev.side} · ${fmtTimeSec(ev.t)}`,
            rows: [
                { color: ev.side === "CE" ? CE_COLOR : PE_COLOR, label: "OI change", value: fmtCompact(ev.dOI, true) },
                { label: "premium change", value: `${ev.dLTP > 0 ? "+" : ""}${ev.dLTP.toFixed(2)}` },
                { label: "volume in update", value: fmtCompact(ev.dVol) },
                { label: "vs normal update", value: `${ev.multiple.toFixed(1)}x` },
            ],
            note: `${ev.action}: ${actionMeaning(ev.side, ev.action)} (${ev.bias})`,
        }
        : null;

    return (
        <div ref={ref} className="oi-chart">
            <svg
                width={width}
                height={height}
                role="img"
                aria-label="Big-player OI entries by time and strike, with the spot price path"
                tabIndex={0}
                onPointerMove={onMove}
                onPointerLeave={() => setHover(null)}
                onKeyDown={onKey}
                onBlur={() => setHover(null)}
            >
                {ticks.map((t) => (
                    <g key={t}>
                        <line className="oi-grid" x1={M.l} x2={width - M.r} y1={y(t)} y2={y(t)} />
                        <text className="oi-axis-text" x={M.l - 6} y={y(t)} dy="0.32em" textAnchor="end">
                            {t}
                        </text>
                    </g>
                ))}

                {xTicks.map((t, i) => (
                    <text
                        key={i}
                        className="oi-axis-text"
                        x={x(t)}
                        y={height - 8}
                        textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}
                    >
                        {timeFmt(t)}
                    </text>
                ))}

                <path d={spotPath} className="oi-line oi-spot-path" />

                {[...shown].reverse().map((e, k) => {
                    const i = shown.length - 1 - k;
                    const color = e.side === "CE" ? CE_COLOR : PE_COLOR;
                    const added = e.dOI > 0;
                    return (
                        <circle
                            key={`${e.t}-${e.strike}-${e.side}`}
                            cx={x(e.t)}
                            cy={y(e.strike)}
                            r={r(e) + (hover === i ? 2 : 0)}
                            className={added ? "oi-dot" : "oi-ring"}
                            style={added ? { fill: color } : { stroke: color }}
                        />
                    );
                })}
            </svg>
            {!shown.length && <div className="oi-overlay-note">No unusual OI jumps detected yet</div>}
            <Tooltip tip={tip} width={width} />
        </div>
    );
}
