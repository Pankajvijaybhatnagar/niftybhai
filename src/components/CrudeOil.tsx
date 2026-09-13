import  { useCallback, useEffect, useState } from "react";
import CrudeOilFilters from "../components/CrudeOilFilters";
import CrudeOilTable from "../components/CrudeOilTable";
import CrudeOilServices from "../services/crudeoilServices";

const CrudeOil = () => {
    const [loading, setLoading] = useState(false);

    const [filters, setFilters] = useState({
        type: "OPTION_CHAIN",
        symbol: "CRUDEOIL",
        expiry: "",
    });

    const [expiryList, setExpiryList] = useState([]);

    const [optionChainData, setOptionChainData] = useState([]);

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Unwrap the MCX API envelope.
     * Actual response shape: { d: { Data: [...rows], Summary: {...} } }
     * Handles three cases:
     *   1. response.d.Data  → standard MCX shape
     *   2. response.Data    → service already stripped "d"
     *   3. response itself  → service returns array directly
     */
    const unwrapRows = (response:any) => {
        const rows =
            response?.d?.Data ??
            response?.Data ??
            (Array.isArray(response) ? response : []);

        if (!Array.isArray(rows)) {
            console.warn("Unexpected MCX response shape:", response);
            return [];
        }

        return rows;
    };

    // ─────────────────────────────────────────────────────────────────────────
    // Load expiry dates — runs once on mount
    // ─────────────────────────────────────────────────────────────────────────
    const loadExpiries = async () => {
        try {
            setLoading(true);

            const expiries : any= await CrudeOilServices.getExpiriesArray("CRUDEOIL");

            setExpiryList(expiries);

            if (expiries.length) {
                setFilters((prev) => ({
                    ...prev,
                    expiry: expiries[0],
                }));
            }
        } catch (error) {
            console.error("Error loading expiries:", error);
        } finally {
            setLoading(false);
        }
    };

    // ─────────────────────────────────────────────────────────────────────────
    // Load option chain data
    // ─────────────────────────────────────────────────────────────────────────
    const loadOptionChainData = async (commodity: string, expiry: string) => {
        try {
            if (!commodity || !expiry) return;

            setLoading(true);

            const response = await CrudeOilServices.fetchMCXOptionChain({
                commodity,
                expiry,
            });

            console.log("MCX Option Chain Response:", response);

            const rows: any = unwrapRows(response);

            console.log(`MCX rows: ${rows.length}, spot: ${rows[0]?.UnderlyingValue}`);

            setOptionChainData(rows);
        } catch (error) {
            console.error("Error loading option chain:", error);
        } finally {
            setLoading(false);
        }
    };

    // ─────────────────────────────────────────────────────────────────────────
    // fetchOptionChain — passed to CrudeOilTable for 2-second self-polling.
    // Re-created only when symbol or expiry changes so the poll loop restarts
    // with the correct params after a filter change.
    // ─────────────────────────────────────────────────────────────────────────
    const fetchOptionChain = useCallback(async () => {
        const { symbol, expiry } = filters;
        if (!symbol || !expiry) return undefined;

        try {
            const response = await CrudeOilServices.fetchMCXOptionChain({
                commodity: symbol,
                expiry,
            });

            const rows = unwrapRows(response);
            return rows.length ? rows : undefined;
        } catch (error) {
            console.error("Error in fetchOptionChain:", error);
            return undefined;
        }
    }, [filters.symbol, filters.expiry]);

    // ─────────────────────────────────────────────────────────────────────────
    // Effects
    // ─────────────────────────────────────────────────────────────────────────

    /** Initial expiry load */
    useEffect(() => {
        loadExpiries();
    }, []);

    /** Fetch data whenever expiry changes (initial data before polling starts) */
    useEffect(() => {
        if (filters.expiry) {
            loadOptionChainData(filters.symbol, filters.expiry);
        }
    }, [filters.expiry, filters.symbol]);

    // ─────────────────────────────────────────────────────────────────────────
    // Filter change handler
    // ─────────────────────────────────────────────────────────────────────────
    const handleFilterChange = (updatedFilters:any) => {
        setFilters(updatedFilters);
    };

    // ─────────────────────────────────────────────────────────────────────────
    // Render
    // ─────────────────────────────────────────────────────────────────────────
    return (
        <div>
            <h1 style={{ marginBottom: "20px" }}>Crude Oil Option Chain</h1>

            <CrudeOilFilters
                expiryList={expiryList}
                onChange={handleFilterChange}
            />

            <CrudeOilTable
                loading={loading}
                data={optionChainData}
                fetchOptionChain={filters.expiry ? fetchOptionChain : undefined}
            />
        </div>
    );
};

export default CrudeOil;