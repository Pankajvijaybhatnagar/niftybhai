import React, { useEffect, useState } from "react";

const CrudeOilFilters = ({
    expiryList = [],
    onChange,
}) => {
    const [type] = useState("OPTION_CHAIN");
    const [symbol] = useState("CRUDEOIL");
    const [expiry, setExpiry] = useState(expiryList[0] || "");

    useEffect(() => {
        if (expiryList.length && !expiry) {
            setExpiry(expiryList[0]);
        }
    }, [expiryList]);

    useEffect(() => {
        if (onChange) {
            onChange({
                type,
                symbol,
                expiry,
            });
        }
    }, [type, symbol, expiry]);

    return (
        <div
            style={{
                display: "flex",
                gap: "12px",
                flexWrap: "wrap",
                padding: "12px",
                background: "#0f172a",
                borderRadius: "10px",
                border: "1px solid #334155",
                marginBottom: "15px",
                alignItems: "center",
            }}
        >
            {/* TYPE */}
            <div style={{ display: "flex", flexDirection: "column" }}>
                <label
                    style={{
                        color: "#94a3b8",
                        fontSize: "12px",
                        marginBottom: "5px",
                    }}
                >
                    Type
                </label>

                <input
                    value={type}
                    readOnly
                    style={{
                        padding: "8px 10px",
                        borderRadius: "6px",
                        background: "#111827",
                        color: "#fff",
                        border: "1px solid #475569",
                        minWidth: "150px",
                    }}
                />
            </div>

            {/* SYMBOL */}
            <div style={{ display: "flex", flexDirection: "column" }}>
                <label
                    style={{
                        color: "#94a3b8",
                        fontSize: "12px",
                        marginBottom: "5px",
                    }}
                >
                    Symbol
                </label>

                <input
                    value={symbol}
                    readOnly
                    style={{
                        padding: "8px 10px",
                        borderRadius: "6px",
                        background: "#111827",
                        color: "#fff",
                        border: "1px solid #475569",
                        minWidth: "150px",
                    }}
                />
            </div>

            {/* EXPIRY */}
            <div style={{ display: "flex", flexDirection: "column" }}>
                <label
                    style={{
                        color: "#94a3b8",
                        fontSize: "12px",
                        marginBottom: "5px",
                    }}
                >
                    Expiry
                </label>

                <select
                    value={expiry}
                    onChange={(e) => setExpiry(e.target.value)}
                    style={{
                        padding: "8px 10px",
                        borderRadius: "6px",
                        background: "#111827",
                        color: "#fff",
                        border: "1px solid #475569",
                        minWidth: "200px",
                    }}
                >
                    {expiryList.map((item) => (
                        <option key={item} value={item}>
                            {item}
                        </option>
                    ))}
                </select>
            </div>
        </div>
    );
};

export default CrudeOilFilters;