import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OptionChainRow } from "../types/optionChain";
import OIAnalytics from "./oi/OIAnalytics";
import { fromNseRows, useOIHistory } from "./oi/oiData";
import StrikeDrawer from "./oi/StrikeDrawer";
import type { CellMetric, CellSelection } from "./oi/StrikeDrawer";
import type { SignalLevels } from "./oi/oiMath";

interface Props {
    loading: boolean;
    optionChain?: OptionChainRow[];
    fetchOptionChain?: () => Promise<OptionChainRow[] | undefined>;
}

const OptionChainTable: React.FC<Props> = ({
    loading,
    optionChain = [],
    fetchOptionChain,
}) => {
    const [liveData, setLiveData] = useState<OptionChainRow[]>([]);
    const [lastUpdated, setLastUpdated] = useState<Date>(new Date());

    const pollingRef = useRef<number | null>(null);
    const fetchingRef = useRef(false);

    // UI-only state: which tab is open and which cell's chart drawer is showing
    const [tab, setTab] = useState<"chain" | "oi">("chain");
    const [selection, setSelection] = useState<CellSelection | null>(null);
    const tableWrapRef = useRef<HTMLDivElement>(null);
    const scrolledForRef = useRef<string | null>(null);

    const loadData = async () => {
        if (!fetchOptionChain || fetchingRef.current) return;

        fetchingRef.current = true;

        try {
            const fresh = await fetchOptionChain();
        //    console.log("Fetched fresh option chain data:", fresh);
            if (fresh && Array.isArray(fresh)) {
                // force fresh reference every poll so UI always re-renders
                setLiveData([...fresh]);
                setLastUpdated(new Date());
            }
        } catch (error) {
            console.error("Auto refresh failed:", error);
        } finally {
            fetchingRef.current = false;
        }
    };

    // initial prop sync
    useEffect(() => {
        if (optionChain?.length) {
            setLiveData([...optionChain]);
            setLastUpdated(new Date());
        }
    }, [optionChain]);

    // auto refresh polling
    useEffect(() => {
        // if (!fetchOptionChain) return;

        loadData(); // initial fetch

        pollingRef.current = setInterval(() => {
            // console.log("Auto refreshing option chain in 2 seconds...");
            loadData();
        }, 2000);

        return () => {
            if (pollingRef.current) {
                clearInterval(pollingRef.current);
                pollingRef.current = null;
            }
        };
    }, [fetchOptionChain]);

    const {
        tableRows,
        pressureSide,
        callBuy,
        putBuy,
        waitLow,
        waitHigh,
        tradeSignal,
        etaText,
        levels,
    } = useMemo(() => {
        if (!liveData?.length) {
            return {
                tableRows: [] as React.ReactNode[],
                pressureSide: "NEUTRAL",
                callBuy: null,
                putBuy: null,
                waitLow: null,
                waitHigh: null,
                tradeSignal: "WAIT",
                etaText: "--",
                levels: null as SignalLevels | null,
            };
        }

        const safe = (v: unknown) => Number(v || 0);
        const snap = (v: number) => Math.round(v / 12.5) * 12.5;
        const L = (v: unknown) => Number(v || 0).toLocaleString("en-IN");

        const spot = safe(
            (liveData?.[0]?.CE as any)?.underlyingValue ||
            (liveData?.[0]?.PE as any)?.underlyingValue
        );

        const reversalMap: Record<number, number> = {};

        // strike levels near spot for reversal mapping (include 50-point strikes too)
        const roundRows = liveData.filter((r) => safe(r.strikePrice) % 50 === 0);
        const nearbyRounds = roundRows.filter(
            (r) => Math.abs(safe(r.strikePrice) - spot) <= 300
        );

        nearbyRounds.forEach((row) => {
            const strike = safe(row.strikePrice);

            const ceOI = safe((row.CE as any)?.openInterest);
            const peOI = safe((row.PE as any)?.openInterest);
            const ceChg = safe((row.CE as any)?.changeinOpenInterest);
            const peChg = safe((row.PE as any)?.changeinOpenInterest);
            const ceVol = safe((row.CE as any)?.totalTradedVolume);
            const peVol = safe((row.PE as any)?.totalTradedVolume);

            const up = liveData.find((r) => safe(r.strikePrice) === strike + 50);
            const dn = liveData.find((r) => safe(r.strikePrice) === strike - 50);

            const upPEVol = safe((up?.PE as any)?.totalTradedVolume);
            const dnCEVol = safe((dn?.CE as any)?.totalTradedVolume);

            const supportPressure =
                peOI * 0.5 + Math.max(peChg, 0) * 0.3 + peVol * 0.2;

            const resistancePressure =
                ceOI * 0.5 + Math.max(ceChg, 0) * 0.3 + ceVol * 0.2;

            const supportReverse = snap(
                strike +
                ((upPEVol + Math.max(peChg, 0)) /
                    Math.max(1, peVol + upPEVol + Math.max(peChg, 0))) *
                    50
            );

            const resistanceReverse = snap(
                strike -
                ((dnCEVol + Math.max(ceChg, 0)) /
                    Math.max(1, ceVol + dnCEVol + Math.max(ceChg, 0))) *
                    50
            );

            reversalMap[strike] =
                supportPressure > resistancePressure ? supportReverse : resistanceReverse;
        });

        // =========================
        // ATM strike (nearest to spot, for the ATM highlight)
        // =========================
        const sortedBySpot = [...liveData].sort(
            (a, b) =>
                Math.abs(safe(a.strikePrice) - spot) - Math.abs(safe(b.strikePrice) - spot)
        );

        const atmStrike = sortedBySpot.length ? safe(sortedBySpot[0].strikePrice) : null;

        // =========================
        // Max Pain: the strike where option writers, in aggregate, lose the
        // least if the underlying settles there - tested against every strike.
        // =========================
        const oiByStrike = liveData.map((row) => ({
            strike: safe(row.strikePrice),
            ceOI: safe((row.CE as any)?.openInterest),
            peOI: safe((row.PE as any)?.openInterest),
        }));

        let maxPainStrike: number | null = null;
        let minPain = Infinity;

        for (const candidate of oiByStrike) {
            const settlement = candidate.strike;
            let totalPain = 0;

            for (const { strike: k, ceOI, peOI } of oiByStrike) {
                if (settlement > k) totalPain += (settlement - k) * ceOI;
                if (settlement < k) totalPain += (k - settlement) * peOI;
            }

            if (totalPain < minPain) {
                minPain = totalPain;
                maxPainStrike = settlement;
            }
        }

        // =========================
        // Highest value per column (CE and PE never compared to each other)
        // =========================
        type HotField = "ceOI" | "ceChg" | "ceVol" | "peOI" | "peChg" | "peVol";
        const hottestByField: Partial<Record<HotField, { strike: number; value: number }>> = {};

        liveData.forEach((row) => {
            const strike = safe(row.strikePrice);
            const fields: Record<HotField, number> = {
                ceOI: safe((row.CE as any)?.openInterest),
                ceChg: safe((row.CE as any)?.changeinOpenInterest),
                ceVol: safe((row.CE as any)?.totalTradedVolume),
                peOI: safe((row.PE as any)?.openInterest),
                peChg: safe((row.PE as any)?.changeinOpenInterest),
                peVol: safe((row.PE as any)?.totalTradedVolume),
            };

            (Object.keys(fields) as HotField[]).forEach((field) => {
                const value = fields[field];
                const current = hottestByField[field];
                if (!current || value > current.value) {
                    hottestByField[field] = { strike, value };
                }
            });
        });

        // =========================
        // "Highest value" = whichever of OI / Change-in-OI / Volume sits nearest to
        // spot - checked together, per side. That one column becomes the support
        // (PE) or resistance (CE) line. The 78% "second highest" check afterwards
        // stays confined to that SAME winning column only - the other two columns
        // for that side get no highlight at all.
        // =========================
        const nearestOf = (
            fields: HotField[]
        ): { field: HotField; strike: number; value: number } | null => {
            let best: { field: HotField; strike: number; value: number } | null = null;

            fields.forEach((field) => {
                const entry = hottestByField[field];
                if (!entry) return;

                if (!best || Math.abs(entry.strike - spot) < Math.abs(best.strike - spot)) {
                    best = { field, strike: entry.strike, value: entry.value };
                }
            });

            return best;
        };

        const nearestCEHot = nearestOf(["ceOI", "ceChg", "ceVol"]);
        const nearestPEHot = nearestOf(["peOI", "peChg", "peVol"]);

        const winningCEField = nearestCEHot?.field ?? null;
        const winningPEField = nearestPEHot?.field ?? null;

        const fieldValue = (field: HotField, row: OptionChainRow): number => {
            switch (field) {
                case "ceOI": return safe((row.CE as any)?.openInterest);
                case "ceChg": return safe((row.CE as any)?.changeinOpenInterest);
                case "ceVol": return safe((row.CE as any)?.totalTradedVolume);
                case "peOI": return safe((row.PE as any)?.openInterest);
                case "peChg": return safe((row.PE as any)?.changeinOpenInterest);
                case "peVol": return safe((row.PE as any)?.totalTradedVolume);
            }
        };

        // Among the winning column's cells that clear 78% of the max (excluding
        // the max itself), the one with the largest percentage is "the second
        // highest" and gets its own color.
        const secondHighestInfo = (
            field: HotField | null
        ): { strike: number; pct: number } | null => {
            if (!field) return null;

            const maxEntry = hottestByField[field];
            if (!maxEntry || maxEntry.value <= 0) return null;

            let second: { strike: number; value: number } | null = null;

            for (const row of liveData) {
                const strike = safe(row.strikePrice);
                if (strike === maxEntry.strike) continue;

                const value = fieldValue(field, row);
                if (!second || value > second.value) {
                    second = { strike, value };
                }
            }

            if (!second || second.value < 0.78 * maxEntry.value) return null;
            return { strike: second.strike, pct: second.value / maxEntry.value };
        };

        const ceSecondHighest = secondHighestInfo(winningCEField);
        const peSecondHighest = secondHighestInfo(winningPEField);

        // Between the two sides' second-highest values, whichever is a bigger
        // fraction of its own max is the one more likely to actually move the
        // market - it keeps the strong color, the other is demoted.
        const ceSecondPct = ceSecondHighest?.pct ?? -1;
        const peSecondPct = peSecondHighest?.pct ?? -1;

        const ceSecondIsDominant = ceSecondHighest !== null && ceSecondPct >= peSecondPct;
        const peSecondIsDominant = peSecondHighest !== null && peSecondPct >= ceSecondPct;

        const ceSecondHighestStrike = ceSecondHighest?.strike ?? null;
        const peSecondHighestStrike = peSecondHighest?.strike ?? null;

        const nearestSupport = nearestPEHot
            ? { strike: nearestPEHot.strike, distance: Math.abs(nearestPEHot.strike - spot) }
            : null;

        const nearestResistance = nearestCEHot
            ? { strike: nearestCEHot.strike, distance: Math.abs(nearestCEHot.strike - spot) }
            : null;

        const pressureSide =
            nearestSupport && nearestResistance
                ? nearestSupport.distance < nearestResistance.distance
                    ? "UPSIDE"
                    : "DOWNSIDE"
                : nearestSupport
                    ? "UPSIDE"
                    : nearestResistance
                        ? "DOWNSIDE"
                        : "NEUTRAL";

        const callBuy = nearestSupport
            ? reversalMap[nearestSupport.strike] || nearestSupport.strike
            : null;

        const putBuy = nearestResistance
            ? reversalMap[nearestResistance.strike] || nearestResistance.strike
            : null;

        const waitLow = callBuy ? callBuy + 25 : null;
        const waitHigh = putBuy ? putBuy - 25 : null;

        let tradeSignal = "WAIT";

        if (callBuy !== null && putBuy !== null) {
            if (spot <= callBuy) tradeSignal = "CALL BUY";
            else if (spot >= putBuy) tradeSignal = "PUT BUY";
            else if (
                waitLow !== null &&
                waitHigh !== null &&
                spot > waitLow &&
                spot < waitHigh
            ) {
                tradeSignal = "WAIT";
            } else {
                tradeSignal = pressureSide === "UPSIDE" ? "CALL BIAS" : "PUT BIAS";
            }
        }

        const movementSpan = Math.abs((putBuy || spot) - (callBuy || spot));

        const distanceToTarget =
            tradeSignal === "CALL BUY"
                ? Math.abs(spot - (callBuy ?? spot))
                : tradeSignal === "PUT BUY"
                    ? Math.abs((putBuy ?? spot) - spot)
                    : movementSpan / 2;

        const etaMin = Math.max(5, Math.round(distanceToTarget / 8));
        const etaText = `${etaMin}-${etaMin + 5} min`;

        const tableRows = liveData.map((row, index) => {
            const strike = safe(row.strikePrice);

            const ceOI = safe((row.CE as any)?.openInterest);
            const peOI = safe((row.PE as any)?.openInterest);
            const ceChg = safe((row.CE as any)?.changeinOpenInterest);
            const peChg = safe((row.PE as any)?.changeinOpenInterest);
            const ceVol = safe((row.CE as any)?.totalTradedVolume);
            const peVol = safe((row.PE as any)?.totalTradedVolume);

            const reversalLevel = reversalMap[strike];
            const isRoundInRange = reversalLevel !== undefined;
            const isSupportRow = strike === nearestSupport?.strike;
            const isResistanceRow = strike === nearestResistance?.strike;
            const isATM = strike === atmStrike;
            const isMaxPain = strike === maxPainStrike;

            const rowFields: Record<HotField, number> = {
                ceOI, ceChg, ceVol, peOI, peChg, peVol,
            };

            // Only ONE column per side gets any highlight at all: whichever of
            // OI / Chg-OI / Volume actually won as "the highest value" (nearest to
            // spot) for that side. The other two columns on that side stay plain.
            // Within that single winning column: its exact max is the support/
            // resistance line itself (dark blue); the single runner-up cell that
            // clears 78% with the largest percentage is "the second highest"
            // (purple); anything else within 78% is just notable (light blue).
            const hotStyle = (field: HotField): React.CSSProperties | undefined => {
                const isCEField = field === "ceOI" || field === "ceChg" || field === "ceVol";
                const winningField = isCEField ? winningCEField : winningPEField;

                if (field !== winningField) return undefined;

                const columnMax = hottestByField[field]?.value ?? 0;
                if (columnMax <= 0) return undefined;

                const isNearColumnMax = rowFields[field] >= 0.78 * columnMax;
                if (!isNearColumnMax) return undefined;

                const isColumnMax = hottestByField[field]?.strike === strike;
                if (isColumnMax) {
                    return { backgroundColor: "#38bdf8", color: "#0f172a", fontWeight: "bold" };
                }

                const secondHighestStrikeForSide = isCEField
                    ? ceSecondHighestStrike
                    : peSecondHighestStrike;

                if (strike === secondHighestStrikeForSide) {
                    const isDominant = isCEField ? ceSecondIsDominant : peSecondIsDominant;

                    // The more market-moving of the two sides' second-highest
                    // values (bigger % of its own max) keeps the strong purple;
                    // the other side's second-highest is demoted to a lighter one.
                    return isDominant
                        ? { backgroundColor: "#a855f7", color: "#fff", fontWeight: "bold" }
                        : { backgroundColor: "#e9d5ff", color: "#3b0764" };
                }

                return { backgroundColor: "#e0f2fe", color: "#0f172a" };
            };

            // Shows the second-highest value's percentage-of-max under it, so the
            // number backing the purple/light-purple color is visible, not just implied.
            const cellContent = (field: HotField, value: number) => {
                const isCEField = field === "ceOI" || field === "ceChg" || field === "ceVol";
                const secondHighestStrikeForSide = isCEField
                    ? ceSecondHighestStrike
                    : peSecondHighestStrike;
                const secondHighestForSide = isCEField ? ceSecondHighest : peSecondHighest;

                const showPct =
                    field === (isCEField ? winningCEField : winningPEField) &&
                    strike === secondHighestStrikeForSide;

                return (
                    <>
                        {L(value)}
                        {showPct && secondHighestForSide && (
                            <div style={{ fontSize: "10px" }}>
                                {(secondHighestForSide.pct * 100).toFixed(1)}%
                            </div>
                        )}
                    </>
                );
            };

            // clicking any CE / PE number opens that strike's charts
            const cell = (side: "CE" | "PE", metric: CellMetric) => {
                const itm = side === "CE" ? strike < spot : strike > spot;
                const open = () => setSelection({ strike, side, metric });
                return {
                    className: `oc-click oc-cell-${side.toLowerCase()}${itm ? " oc-itm" : ""}`,
                    role: "button",
                    tabIndex: 0,
                    title: `${side} ${strike} - click for chart`,
                    onClick: open,
                    onKeyDown: (e: React.KeyboardEvent) => {
                        if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            open();
                        }
                    },
                };
            };

            return (
                <tr key={`${strike}-${index}`} data-atm={isATM || undefined}>
                    <td {...cell("CE", "oi")} style={hotStyle("ceOI")}>{cellContent("ceOI", ceOI)}</td>
                    <td {...cell("CE", "chg")} style={hotStyle("ceChg")}>{cellContent("ceChg", ceChg)}</td>
                    <td {...cell("CE", "ltp")}>{(row.CE as any)?.lastPrice ?? "-"}</td>
                    <td {...cell("CE", "vol")} style={hotStyle("ceVol")}>{cellContent("ceVol", ceVol)}</td>

                    <td
                        className="oc-strike"
                        style={{
                            backgroundColor: isATM ? "#fbbf24" : undefined,
                            color: isATM ? "#111827" : undefined,
                            outline: isMaxPain ? "3px solid #22c55e" : undefined,
                            outlineOffset: isMaxPain ? "-3px" : undefined,
                        }}
                    >
                        <div>{strike}</div>
                        {(isSupportRow || isResistanceRow || isRoundInRange || isMaxPain) && (
                            <div className="oc-tags">
                                {isSupportRow && <span className="oc-tag">Support</span>}
                                {isResistanceRow && <span className="oc-tag">Resistance</span>}
                                {isRoundInRange && <span className="oc-tag">Reverse ≈ {reversalLevel}</span>}
                                {isMaxPain && <span className="oc-tag oc-tag-maxpain">Max Pain</span>}
                            </div>
                        )}
                    </td>

                    <td {...cell("PE", "vol")} style={hotStyle("peVol")}>{cellContent("peVol", peVol)}</td>
                    <td {...cell("PE", "ltp")}>{(row.PE as any)?.lastPrice ?? "-"}</td>
                    <td {...cell("PE", "chg")} style={hotStyle("peChg")}>{cellContent("peChg", peChg)}</td>
                    <td {...cell("PE", "oi")} style={hotStyle("peOI")}>{cellContent("peOI", peOI)}</td>
                </tr>
            );
        });

        return {
            tableRows,
            pressureSide,
            callBuy,
            putBuy,
            waitLow,
            waitHigh,
            tradeSignal,
            etaText,
            // the levels above, exposed read-only for the OI charts / forecasts
            levels: {
                spot,
                supportStrike: nearestSupport?.strike ?? null,
                resistanceStrike: nearestResistance?.strike ?? null,
                supportField: winningPEField,
                resistanceField: winningCEField,
                ceSecondStrike: ceSecondHighestStrike,
                peSecondStrike: peSecondHighestStrike,
                atmStrike,
                maxPainStrike,
                callBuy,
                putBuy,
            } as SignalLevels,
        };
    }, [liveData]);

    // same live data, normalised for the OI charts (read-only - no signal logic involved).
    // History is recorded here so it keeps tracking whichever tab is open.
    const oiSource = useMemo(() => fromNseRows(liveData), [liveData]);
    const oiHistory = useOIHistory(oiSource);
    const closeDrawer = useCallback(() => setSelection(null), []);

    // bring the ATM row into view once per instrument / expiry
    useEffect(() => {
        const wrap = tableWrapRef.current;
        if (tab !== "chain" || !wrap || !oiSource || scrolledForRef.current === oiSource.id) return;
        const atmRow = wrap.querySelector<HTMLTableRowElement>("tr[data-atm]");
        if (!atmRow) return;
        scrolledForRef.current = oiSource.id;
        wrap.scrollTop = atmRow.offsetTop - wrap.clientHeight / 2;
    }, [oiSource, tab]);

    if (loading && !liveData.length) {
        return (
            <div className="oc-state">
                <span className="oc-spinner" aria-hidden="true" /> Loading option chain...
            </div>
        );
    }
    if (!liveData.length) return <div className="oc-state">No option chain data found.</div>;

    const signalTone =
        tradeSignal === "CALL BUY" || tradeSignal === "CALL BIAS"
            ? "good"
            : tradeSignal === "PUT BUY" || tradeSignal === "PUT BIAS"
                ? "critical"
                : "warning";
    const signalIcon = signalTone === "good" ? "▲" : signalTone === "critical" ? "▼" : "■";
    const pressureTone = pressureSide === "UPSIDE" ? "good" : pressureSide === "DOWNSIDE" ? "critical" : "warning";
    const pressureIcon = pressureSide === "UPSIDE" ? "▲" : pressureSide === "DOWNSIDE" ? "▼" : "■";

    return (
        <div className="oc">
            <div className="oc-signals">
                <div className={`oc-tile oc-signal oc-tone-${signalTone}`}>
                    <div className="oc-tile-label">Signal</div>
                    <div className="oc-tile-value">
                        <span className="oc-icon" aria-hidden="true">{signalIcon}</span>
                        {tradeSignal}
                    </div>
                    <div className="oc-tile-sub">Expected move time: {etaText}</div>
                </div>
                <div className={`oc-tile oc-tone-${pressureTone}`}>
                    <div className="oc-tile-label">Pressure</div>
                    <div className="oc-tile-value">
                        <span className="oc-icon" aria-hidden="true">{pressureIcon}</span>
                        {pressureSide}
                    </div>
                </div>
                <div className="oc-tile">
                    <div className="oc-tile-label">Call buy</div>
                    <div className="oc-tile-value">{callBuy ?? "-"}</div>
                </div>
                <div className="oc-tile">
                    <div className="oc-tile-label">Put buy</div>
                    <div className="oc-tile-value">{putBuy ?? "-"}</div>
                </div>
                <div className="oc-tile">
                    <div className="oc-tile-label">Wait zone</div>
                    <div className="oc-tile-value oc-tile-value-range">
                        {waitLow !== null && waitHigh !== null && waitLow >= waitHigh
                            ? "No zone"
                            : `${waitLow ?? "-"} – ${waitHigh ?? "-"}`}
                    </div>
                    {waitLow !== null && waitHigh !== null && waitLow >= waitHigh && (
                        <div className="oc-tile-sub">
                            Levels overlap ({waitLow} ≥ {waitHigh})
                        </div>
                    )}
                </div>
                <div className="oc-tile">
                    <div className="oc-tile-label">Spot</div>
                    <div className="oc-tile-value">{oiSource ? oiSource.spot.toLocaleString("en-IN") : "-"}</div>
                    <div className="oc-tile-sub">
                        <span className="oc-live" aria-hidden="true" />
                        Updated {lastUpdated.toLocaleTimeString()}
                    </div>
                </div>
            </div>

            <div className="oc-toolbar">
                <div className="oc-tabs" role="tablist" aria-label="View">
                    <button
                        type="button"
                        role="tab"
                        className="oc-tab"
                        aria-selected={tab === "chain"}
                        onClick={() => setTab("chain")}
                    >
                        Option Chain
                    </button>
                    <button
                        type="button"
                        role="tab"
                        className="oc-tab"
                        aria-selected={tab === "oi"}
                        onClick={() => setTab("oi")}
                    >
                        OI Charts
                    </button>
                </div>
                {tab === "chain" && (
                    <div className="oc-legend">
                        <span><i style={{ background: "#fbbf24" }} />ATM</span>
                        <span><i style={{ outline: "2px solid #22c55e", outlineOffset: "-2px" }} />Max pain</span>
                        <span><i style={{ background: "#38bdf8" }} />Highest</span>
                        <span><i style={{ background: "#a855f7" }} />Second highest</span>
                        <span><i style={{ background: "#e0f2fe" }} />Within 78%</span>
                        <span className="oc-hint">Click any number to open its chart</span>
                    </div>
                )}
            </div>

            {tab === "chain" ? (
                <div className="oc-table-wrap" ref={tableWrapRef}>
                    <table className="oc-table">
                        <thead>
                            <tr>
                                <th colSpan={4} className="oc-th-ce">
                                    <span className="oc-group">
                                        <i style={{ background: "var(--oi-ce)" }} />
                                        Calls
                                    </span>
                                </th>
                                <th className="oc-th-strike" />
                                <th colSpan={4} className="oc-th-pe">
                                    <span className="oc-group">
                                        <i style={{ background: "var(--oi-pe)" }} />
                                        Puts
                                    </span>
                                </th>
                            </tr>
                            <tr>
                                <th className="oc-th-ce">OI</th>
                                <th className="oc-th-ce">Chg OI</th>
                                <th className="oc-th-ce">LTP</th>
                                <th className="oc-th-ce">Volume</th>
                                <th className="oc-th-strike">Strike / Reversal</th>
                                <th className="oc-th-pe">Volume</th>
                                <th className="oc-th-pe">LTP</th>
                                <th className="oc-th-pe">Chg OI</th>
                                <th className="oc-th-pe">OI</th>
                            </tr>
                        </thead>
                        <tbody>{tableRows}</tbody>
                    </table>
                </div>
            ) : (
                <OIAnalytics
                    source={oiSource}
                    history={oiHistory}
                    onOpenStrike={(strike) => setSelection({ strike, side: "CE", metric: "oi" })}
                    levels={levels}
                />
            )}

            {selection && (
                <StrikeDrawer
                    key={`${selection.strike}-${selection.side}-${selection.metric}`}
                    selection={selection}
                    source={oiSource}
                    history={oiHistory}
                    levels={levels}
                    onClose={closeDrawer}
                />
            )}
        </div>
    );
};

export default OptionChainTable;
