import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * CrudeOilTable
 *
 * Props:
 *   loading            – boolean
 *   data               – flat OptionChainRow[]  (CE_OpenInterest, PE_LTP, CE_StrikePrice …)
 *   fetchOptionChain   – async () => flat row[] | undefined   (optional → enables 2-s auto-poll)
 */
const CrudeOilTable = ({ loading, data = [], fetchOptionChain }) => {

    // ─── live-data state ───────────────────────────────────────────────────────
    const [liveData, setLiveData]       = useState([]);
    const [lastUpdated, setLastUpdated] = useState(new Date());

    const pollingRef  = useRef(null);
    const fetchingRef = useRef(false);

    // ─── utility helpers ───────────────────────────────────────────────────────
    const safe = (v) => Number(v || 0);

    /** snap value to nearest crude-oil tick (12.5) */
    const snap = (v) => Math.round(v / 12.5) * 12.5;

    const formatNumber = (value) => {
        if (value === null || value === undefined) return "-";
        const num = Number(value);
        if (num === 0) return "0";
        return num.toLocaleString("en-IN");
    };

    const formatLTP = (value) => {
        if (value === null || value === undefined || value === 0) return "-";
        return Number(value).toFixed(2);
    };

    const formatChange = (value) => {
        if (value === null || value === undefined) return "-";
        const num    = Number(value);
        const color  = num > 0 ? "#22c55e" : num < 0 ? "#ef4444" : "#94a3b8";
        const prefix = num > 0 ? "+" : "";
        return <span style={{ color }}>{prefix}{formatNumber(num)}</span>;
    };

    const formatNetChange = (value) => {
        if (value === null || value === undefined) return "-";
        const num    = Number(value);
        const color  = num > 0 ? "#22c55e" : num < 0 ? "#ef4444" : "#94a3b8";
        const prefix = num > 0 ? "+" : "";
        return <span style={{ color }}>{prefix}{num.toFixed(2)}%</span>;
    };

    const parseMsDate = (dateStr) => {
        if (!dateStr || dateStr === "/Date(-19800000)/") return null;
        const match = dateStr.match(/\/Date\((-?\d+)\)\//);
        if (!match) return null;
        const ms = parseInt(match[1], 10);
        return new Date(ms).toLocaleTimeString("en-IN", {
            hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
        });
    };

    // ─── data loading / polling ────────────────────────────────────────────────
    const loadData = async () => {
        if (!fetchOptionChain || fetchingRef.current) return;
        fetchingRef.current = true;
        try {
            const fresh = await fetchOptionChain();
            if (fresh && Array.isArray(fresh)) {
                setLiveData([...fresh]);
                setLastUpdated(new Date());
            }
        } catch (err) {
            console.error("Auto refresh failed:", err);
        } finally {
            fetchingRef.current = false;
        }
    };

    // sync when parent pushes new prop data
    useEffect(() => {
        if (data?.length) {
            setLiveData([...data]);
            setLastUpdated(new Date());
        }
    }, [data]);

    // auto-refresh polling every 2 s
    useEffect(() => {
        loadData();

        pollingRef.current = setInterval(() => {
            loadData();
        }, 2000);

        return () => {
            if (pollingRef.current) {
                clearInterval(pollingRef.current);
                pollingRef.current = null;
            }
        };
    }, [fetchOptionChain]);

    // ─── analytics (memoised so it only reruns when liveData changes) ──────────
    const {
        tableRows,
        pressureSide,
        callBuy,
        putBuy,
        waitLow,
        waitHigh,
        tradeSignal,
        etaText,
        spot,
    } = useMemo(() => {
        const EMPTY = {
            tableRows:    [],
            pressureSide: "NEUTRAL",
            callBuy:      null,
            putBuy:       null,
            waitLow:      null,
            waitHigh:     null,
            tradeSignal:  "WAIT",
            etaText:      "--",
            spot:         null,
        };

        if (!liveData?.length) return EMPTY;

        // ── spot price ────────────────────────────────────────────────────────
        const spot = safe(liveData[0]?.UnderlyingValue);

        // ── reversal map ──────────────────────────────────────────────────────
        // only compute for round strikes within ±300 of spot
        const reversalMap = {};

        const nearbyRounds = liveData.filter((row) => {
            const strike = safe(row.CE_StrikePrice);
            return strike % 100 === 0 && Math.abs(strike - spot) <= 300;
        });

        nearbyRounds.forEach((row) => {
            const strike = safe(row.CE_StrikePrice);

            const ceOI  = safe(row.CE_OpenInterest);
            const peOI  = safe(row.PE_OpenInterest);
            const ceChg = safe(row.CE_ChangeInOI);
            const peChg = safe(row.PE_ChangeInOI);
            const ceVol = safe(row.CE_Volume);
            const peVol = safe(row.PE_Volume);

            // adjacent strike rows
            const up = liveData.find((r) => safe(r.CE_StrikePrice) === strike + 50);
            const dn = liveData.find((r) => safe(r.CE_StrikePrice) === strike - 50);

            const upPEVol = safe(up?.PE_Volume);
            const dnCEVol = safe(dn?.CE_Volume);

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

        // ── support / resistance detection ────────────────────────────────────
        const sortedBySpot = [...liveData].sort(
            (a, b) =>
                Math.abs(safe(a.CE_StrikePrice) - spot) -
                Math.abs(safe(b.CE_StrikePrice) - spot)
        );

        const supportRows    = sortedBySpot.filter((r) => safe(r.CE_StrikePrice) < spot);
        const resistanceRows = sortedBySpot.filter((r) => safe(r.CE_StrikePrice) > spot);

        const findFirstSupport = () => {
            for (const row of supportRows) {
                const strike = safe(row.CE_StrikePrice);
                const ceOI   = safe(row.CE_OpenInterest);
                const peOI   = safe(row.PE_OpenInterest);
                // strong support: PE OI is at least 2× CE OI
                if (peOI >= ceOI * 2) {
                    const peChg = Math.max(0, safe(row.PE_ChangeInOI));
                    const peVol = safe(row.PE_Volume);
                    return {
                        strike,
                        score:    peOI * 0.70 + peChg * 0.20 + peVol * 0.10,
                        distance: Math.abs(strike - spot),
                    };
                }
            }
            return null;
        };

        const findFirstResistance = () => {
            for (const row of resistanceRows) {
                const strike = safe(row.CE_StrikePrice);
                const ceOI   = safe(row.CE_OpenInterest);
                const peOI   = safe(row.PE_OpenInterest);
                // strong resistance: CE OI is at least 2× PE OI
                if (ceOI >= peOI * 2) {
                    const ceChg = Math.max(0, safe(row.CE_ChangeInOI));
                    const ceVol = safe(row.CE_Volume);
                    return {
                        strike,
                        score:    ceOI * 0.70 + ceChg * 0.20 + ceVol * 0.10,
                        distance: Math.abs(strike - spot),
                    };
                }
            }
            return null;
        };

        const nearestSupport    = findFirstSupport();
        const nearestResistance = findFirstResistance();

        const nearestPEWall = nearestSupport    || null;
        const nearestCEWall = nearestResistance || null;

        // ── pressure side ─────────────────────────────────────────────────────
        const pressureSide =
            nearestPEWall && nearestCEWall
                ? nearestPEWall.distance < nearestCEWall.distance
                    ? "UPSIDE"
                    : "DOWNSIDE"
                : nearestPEWall
                    ? "UPSIDE"
                    : nearestCEWall
                        ? "DOWNSIDE"
                        : "NEUTRAL";

        // ── trade levels ──────────────────────────────────────────────────────
        const callBuy = nearestPEWall
            ? (reversalMap[nearestPEWall.strike] ?? nearestPEWall.strike)
            : null;

        const putBuy = nearestCEWall
            ? (reversalMap[nearestCEWall.strike] ?? nearestCEWall.strike)
            : null;

        const waitLow  = callBuy !== null ? callBuy + 25 : null;
        const waitHigh = putBuy  !== null ? putBuy  - 25 : null;

        // ── trade signal ──────────────────────────────────────────────────────
        let tradeSignal = "WAIT";
        if (callBuy !== null && putBuy !== null) {
            if      (spot <= callBuy) {
                tradeSignal = "CALL BUY";
            } else if (spot >= putBuy) {
                tradeSignal = "PUT BUY";
            } else if (
                waitLow  !== null &&
                waitHigh !== null &&
                spot > waitLow &&
                spot < waitHigh
            ) {
                tradeSignal = "WAIT";
            } else {
                tradeSignal = pressureSide === "UPSIDE" ? "CALL BIAS" : "PUT BIAS";
            }
        }

        // ── ETA calculation ───────────────────────────────────────────────────
        const movementSpan = Math.abs((putBuy || spot) - (callBuy || spot));
        const distanceToTarget =
            tradeSignal === "CALL BUY"
                ? Math.abs(spot - (callBuy ?? spot))
                : tradeSignal === "PUT BUY"
                    ? Math.abs((putBuy ?? spot) - spot)
                    : movementSpan / 2;

        const etaMin  = Math.max(5, Math.round(distanceToTarget / 8));
        const etaText = `${etaMin}-${etaMin + 5} min`;

        // ── build table rows ──────────────────────────────────────────────────
        const tableRows = liveData.map((item, index) => {
            const strike         = safe(item.CE_StrikePrice);
            const uv             = item.UnderlyingValue ?? spot;
            const reversalLevel  = reversalMap[strike];
            const isRoundInRange = reversalLevel !== undefined;
            const isATM          = Math.abs(strike - uv) <= 50;
            const isSupportRow   = strike === nearestSupport?.strike;
            const isResistanceRow = strike === nearestResistance?.strike;
            const isCEInactive   = !item.CE_LTP && !item.CE_Volume && !item.CE_OpenInterest;

            // row background priority: support > resistance > reversal > ATM > default
            let rowBg = index % 2 === 0 ? "#111827" : "#0f172a";
            if      (isSupportRow)                             rowBg = "#0f766e";
            else if (isResistanceRow)                          rowBg = "#991b1b";
            else if (isRoundInRange && reversalLevel < strike) rowBg = "#3b0a0a";
            else if (isRoundInRange && reversalLevel > strike) rowBg = "#0b2e13";
            else if (isATM)                                    rowBg = "#4a3b00";

            const strikeCellBg =
                isSupportRow    ? "#0e9488" :
                isResistanceRow ? "#b91c1c" :
                isATM           ? "#7c5e00" : "#1e293b";

            const strikeCellColor =
                isSupportRow    ? "#d1fae5" :
                isResistanceRow ? "#fca5a5" :
                isATM           ? "#fbbf24" : "#e2e8f0";

            return (
                <tr
                    key={`${strike}-${index}`}
                    style={{ backgroundColor: rowBg, color: "#fff" }}
                    onMouseEnter={(e) => (e.currentTarget.style.filter = "brightness(1.25)")}
                    onMouseLeave={(e) => (e.currentTarget.style.filter = "brightness(1)")}
                >
                    {/* ── CE columns ── */}
                    <td style={{ ...tdStyle, color: isCEInactive ? "#334155" : "#fff" }}>
                        {formatNumber(item.CE_OpenInterest)}
                    </td>
                    <td style={tdStyle}>
                        {isCEInactive ? "-" : formatChange(item.CE_ChangeInOI)}
                    </td>
                    <td style={{ ...tdStyle, color: isCEInactive ? "#334155" : "#fff" }}>
                        {formatNumber(item.CE_Volume)}
                    </td>
                    <td style={{ ...tdStyle, color: isCEInactive ? "#334155" : "#60a5fa" }}>
                        {isCEInactive ? "-" : formatLTP(item.CE_BidPrice)}
                    </td>
                    <td style={{ ...tdStyle, color: isCEInactive ? "#334155" : "#f97316" }}>
                        {isCEInactive ? "-" : formatLTP(item.CE_AskPrice)}
                    </td>
                    <td style={{ ...tdStyle, fontWeight: "600" }}>
                        {isCEInactive ? "-" : formatLTP(item.CE_LTP)}
                    </td>
                    <td style={tdStyle}>
                        {isCEInactive ? "-" : formatNetChange(item.CE_NetChange)}
                    </td>
                    <td style={{ ...tdStyle, color: "#64748b", fontSize: "11px" }}>
                        {parseMsDate(item.CE_LTT) ?? "-"}
                    </td>

                    {/* ── Strike / Reversal cell ── */}
                    <td style={{
                        ...tdStyle,
                        fontWeight: "bold",
                        fontSize: "13px",
                        background: strikeCellBg,
                        color: strikeCellColor,
                        minWidth: "130px",
                    }}>
                        <div>{strike}</div>
                        {isSupportRow && (
                            <div style={{ marginTop: "3px", fontSize: "10px", color: "#86efac" }}>
                                Support
                            </div>
                        )}
                        {isResistanceRow && (
                            <div style={{ marginTop: "3px", fontSize: "10px", color: "#fca5a5" }}>
                                Resistance
                            </div>
                        )}
                        {isRoundInRange && (
                            <div style={{
                                marginTop: "3px",
                                fontSize: "10px",
                                color: reversalLevel < strike ? "#fca5a5" : "#86efac",
                            }}>
                                Reverse ≈ {reversalLevel}
                            </div>
                        )}
                    </td>

                    {/* ── PE columns ── */}
                    <td style={{ ...tdStyle, color: "#64748b", fontSize: "11px" }}>
                        {parseMsDate(item.PE_LTT) ?? "-"}
                    </td>
                    <td style={tdStyle}>
                        {formatNetChange(item.PE_NetChange)}
                    </td>
                    <td style={{ ...tdStyle, fontWeight: "600" }}>
                        {formatLTP(item.PE_LTP)}
                    </td>
                    <td style={{ ...tdStyle, color: "#60a5fa" }}>
                        {formatLTP(item.PE_BidPrice)}
                    </td>
                    <td style={{ ...tdStyle, color: "#f97316" }}>
                        {formatLTP(item.PE_AskPrice)}
                    </td>
                    <td style={tdStyle}>
                        {formatNumber(item.PE_Volume)}
                    </td>
                    <td style={tdStyle}>
                        {formatChange(item.PE_ChangeInOI)}
                    </td>
                    <td style={tdStyle}>
                        {formatNumber(item.PE_OpenInterest)}
                    </td>
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
            spot,
        };
    }, [liveData]);

    // ─── render guards ─────────────────────────────────────────────────────────
    if (loading && !liveData.length) {
        return (
            <div style={{ color: "#94a3b8", marginTop: "20px", padding: "20px", textAlign: "center" }}>
                Loading Option Chain...
            </div>
        );
    }

    if (!liveData.length) {
        return (
            <div style={{ color: "#94a3b8", marginTop: "20px", padding: "20px", textAlign: "center" }}>
                No Option Chain Data Found
            </div>
        );
    }

    // signal colour
    const signalColor =
        tradeSignal === "CALL BUY"  ? "#22c55e" :
        tradeSignal === "PUT BUY"   ? "#ef4444" :
        tradeSignal === "CALL BIAS" ? "#86efac" :
        tradeSignal === "PUT BIAS"  ? "#fca5a5" : "#fbbf24";

    // ─── render ────────────────────────────────────────────────────────────────
    return (
        <div style={{ marginTop: "20px" }}>

            {/* ── top bar: underlying + last-updated ── */}
            <div style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: "8px",
                marginBottom: "8px",
            }}>
                {spot !== null && (
                    <div style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "10px",
                        padding: "6px 14px",
                        background: "#1e293b",
                        borderRadius: "8px",
                        fontSize: "13px",
                        color: "#94a3b8",
                    }}>
                        <span>Underlying</span>
                        <span style={{ color: "#f8fafc", fontWeight: "bold", fontSize: "15px" }}>
                            {spot.toLocaleString("en-IN")}
                        </span>
                    </div>
                )}
                <div style={{ color: "#64748b", fontSize: "11px" }}>
                    Auto Updated: {lastUpdated.toLocaleTimeString()}
                </div>
            </div>

            {/* ── signal panel ── */}
            <div style={{
                marginBottom: "12px",
                padding: "12px 16px",
                borderRadius: "10px",
                background: "#0f172a",
                border: "1px solid #334155",
                color: "#fff",
                fontSize: "13px",
                fontWeight: "bold",
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                gap: "4px 20px",
                lineHeight: "2",
            }}>
                <div>
                    Pressure:{" "}
                    <span style={{
                        color: pressureSide === "UPSIDE"   ? "#22c55e" :
                               pressureSide === "DOWNSIDE" ? "#ef4444" : "#fbbf24",
                    }}>
                        {pressureSide}
                    </span>
                </div>
                <div>
                    Signal:{" "}
                    <span style={{ color: signalColor }}>{tradeSignal}</span>
                </div>
                <div style={{ color: "#86efac" }}>
                    CALL BUY: {callBuy ?? "-"}
                </div>
                <div style={{ color: "#fca5a5" }}>
                    PUT BUY: {putBuy ?? "-"}
                </div>
                <div style={{ color: "#fbbf24" }}>
                    WAIT ZONE: {waitLow ?? "-"} – {waitHigh ?? "-"}
                </div>
                <div style={{ color: "#94a3b8" }}>
                    Expected Move: {etaText}
                </div>
            </div>

            {/* ── option chain table ── */}
            <div style={{ overflowX: "auto", border: "1px solid #334155", borderRadius: "10px" }}>
                <table style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    background: "#0f172a",
                    color: "#fff",
                    fontSize: "12px",
                }}>
                    <thead>
                        <tr style={{ background: "#1e293b" }}>
                            {/* CE */}
                            <th style={thStyle}>CE OI</th>
                            <th style={thStyle}>CE Chg OI</th>
                            <th style={thStyle}>CE Volume</th>
                            <th style={thStyle}>CE Bid</th>
                            <th style={thStyle}>CE Ask</th>
                            <th style={thStyle}>CE LTP</th>
                            <th style={thStyle}>CE Chg%</th>
                            <th style={thStyle}>CE LTT</th>
                            {/* Strike */}
                            <th style={{ ...thStyle, background: "#334155", minWidth: "130px" }}>
                                Strike / Reversal
                            </th>
                            {/* PE */}
                            <th style={thStyle}>PE LTT</th>
                            <th style={thStyle}>PE Chg%</th>
                            <th style={thStyle}>PE LTP</th>
                            <th style={thStyle}>PE Bid</th>
                            <th style={thStyle}>PE Ask</th>
                            <th style={thStyle}>PE Volume</th>
                            <th style={thStyle}>PE Chg OI</th>
                            <th style={thStyle}>PE OI</th>
                        </tr>
                    </thead>
                    <tbody>{tableRows}</tbody>
                </table>
            </div>

            {/* ── colour legend ── */}
            <div style={{
                display: "flex",
                gap: "16px",
                flexWrap: "wrap",
                marginTop: "10px",
                fontSize: "11px",
                color: "#94a3b8",
            }}>
                {[
                    { bg: "#0f766e", label: "Support" },
                    { bg: "#991b1b", label: "Resistance" },
                    { bg: "#4a3b00", label: "ATM" },
                    { bg: "#0b2e13", label: "Reversal ↑" },
                    { bg: "#3b0a0a", label: "Reversal ↓" },
                ].map(({ bg, label }) => (
                    <div key={label} style={{ display: "flex", alignItems: "center", gap: "5px" }}>
                        <div style={{ width: "12px", height: "12px", borderRadius: "3px", background: bg }} />
                        <span>{label}</span>
                    </div>
                ))}
            </div>
        </div>
    );
};

// ─── shared cell styles ────────────────────────────────────────────────────────
const thStyle = {
    padding: "10px 8px",
    border: "1px solid #334155",
    textAlign: "center",
    whiteSpace: "nowrap",
    fontSize: "11px",
    fontWeight: "600",
    color: "#94a3b8",
    letterSpacing: "0.03em",
};

const tdStyle = {
    padding: "7px 8px",
    border: "1px solid #1e293b",
    textAlign: "center",
    whiteSpace: "nowrap",
};

export default CrudeOilTable;