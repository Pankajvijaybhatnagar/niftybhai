import React, { useEffect, useMemo, useRef, useState } from "react";
import type { OptionChainRow } from "../types/optionChain";

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

            return (
                <tr key={`${strike}-${index}`}>
                    <td style={hotStyle("ceOI")}>{cellContent("ceOI", ceOI)}</td>
                    <td style={hotStyle("ceChg")}>{cellContent("ceChg", ceChg)}</td>
                    <td>{(row.CE as any)?.lastPrice ?? "-"}</td>
                    <td style={hotStyle("ceVol")}>{cellContent("ceVol", ceVol)}</td>

                    <td
                        style={{
                            textAlign: "center",
                            minWidth: "180px",
                            backgroundColor: isATM ? "#fbbf24" : undefined,
                            color: isATM ? "#111827" : undefined,
                            fontWeight: isATM ? "bold" : undefined,
                            outline: isMaxPain ? "3px solid #22c55e" : undefined,
                            outlineOffset: isMaxPain ? "-3px" : undefined,
                        }}
                    >
                        <div>{strike}</div>
                        {isSupportRow && (
                            <div style={{ marginTop: "4px", fontSize: "10px" }}>
                                Support
                            </div>
                        )}
                        {isResistanceRow && (
                            <div style={{ marginTop: "4px", fontSize: "10px" }}>
                                Resistance
                            </div>
                        )}
                        {isRoundInRange && (
                            <div style={{ marginTop: "4px", fontSize: "10px" }}>
                                Reverse ≈ {reversalLevel}
                            </div>
                        )}
                        {isMaxPain && (
                            <div style={{ marginTop: "4px", fontSize: "10px", color: "#22c55e" }}>
                                Max Pain
                            </div>
                        )}
                    </td>

                    <td style={hotStyle("peVol")}>{cellContent("peVol", peVol)}</td>
                    <td>{(row.PE as any)?.lastPrice ?? "-"}</td>
                    <td style={hotStyle("peChg")}>{cellContent("peChg", peChg)}</td>
                    <td style={hotStyle("peOI")}>{cellContent("peOI", peOI)}</td>
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
        };
    }, [liveData]);

    if (loading && !liveData.length) return <p>Loading option chain...</p>;
    if (!liveData.length) return <p>No option chain data found.</p>;

    return (
        <div style={{ overflowX: "auto" }}>
            <div
                style={{
                    fontSize: "11px",
                    marginBottom: "8px",
                    textAlign: "right",
                }}
            >
                Auto Updated: {lastUpdated.toLocaleTimeString()}
            </div>

            <div
                style={{
                    marginBottom: "10px",
                    padding: "10px 12px",
                    borderRadius: "8px",
                    border: "1px solid",
                    lineHeight: "1.8",
                    fontSize: "13px",
                    fontWeight: "bold",
                }}
            >
                <div>Pressure: {pressureSide}</div>
                <div>CALL BUY: {callBuy ?? "-"}</div>
                <div>PUT BUY: {putBuy ?? "-"}</div>
                <div>
                    WAIT: {waitLow ?? "-"} - {waitHigh ?? "-"}
                </div>
                <div>Signal: {tradeSignal}</div>
                <div>Expected Move Time: {etaText}</div>
            </div>

            <table
                border={1}
                cellPadding={8}
                cellSpacing={0}
                style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}
            >
                <thead>
                    <tr>
                        <th>CE OI</th>
                        <th>CE Chg</th>
                        <th>CE LTP</th>
                        <th>CE Vol</th>
                        <th>Strike / Reversal Level</th>
                        <th>PE Vol</th>
                        <th>PE LTP</th>
                        <th>PE Chg</th>
                        <th>PE OI</th>
                    </tr>
                </thead>
                <tbody>{tableRows}</tbody>
            </table>
        </div>
    );
};

export default OptionChainTable;