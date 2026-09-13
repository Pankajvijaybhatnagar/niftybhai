import React, { useCallback, useEffect, useState } from "react";
import OptionChainService from "../services/optionchainServices";
import OptionChainFilters from "./OptionChainFilters";
import OptionChainTable from "./OptionChainTable";
import type { Filters, FilterType, OptionChainRow } from "../types/optionChain";

const Hero: React.FC = () => {
    const [filters, setFilters] = useState<Filters>({
        type: "Indices",
        symbol: "NIFTY",
        expiry: "30-Apr-2026",
    });

    const [expiryDates, setExpiryDates] = useState<string[]>([]);
    const [optionChain, setOptionChain] = useState<OptionChainRow[]>([]);
    const [loading, setLoading] = useState<boolean>(false);

    const typeOptions: FilterType[] = ["Indices", "Stocks"];

    const symbolOptions: Record<FilterType, string[]> = {
        Indices: ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY"],
        Stocks: ["RELIANCE", "SBIN", "TCS", "INFY", "HDFCBANK"],
    };

    const updateFilters = (key: keyof Filters, value: string) => {
        setFilters((prev) => ({
            ...prev,
            [key]: value,
        }));
    };

    const loadExpiryDates = async (updatedFilters: Filters) => {
        try {
            const dates = await OptionChainService.fetchExpiryDates(updatedFilters);
            setExpiryDates(dates || []);

            if (dates?.length) {
                setFilters((prev) => ({
                    ...prev,
                    expiry: dates[0],
                }));
            }
        } catch (error) {
            console.error("Error loading expiry dates:", error);
        }
    };

    const loadOptionChain = async (updatedFilters: Filters = filters) => {
        try {
            setLoading(true);
            const data = await OptionChainService.fetchFormattedOptionChain(updatedFilters);
            setOptionChain(data || []);
        } catch (error) {
            console.error("Error loading option chain:", error);
        } finally {
            setLoading(false);
        }
    };

    const fetchOptionChain = useCallback(async () => {
        try {
            return await OptionChainService.fetchFormattedOptionChain(filters);
        } catch (error) {
            console.error("Error fetching option chain for auto-refresh:", error);
            return [];
        }
    }, [filters]);

    const handleTypeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        const nextType = e.target.value as FilterType;
        const nextSymbol = symbolOptions[nextType][0];

        setFilters({
            type: nextType,
            symbol: nextSymbol,
            expiry: "30-Apr-2026",
        });
    };

    const handleSymbolChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        setFilters((prev) => ({
            ...prev,
            symbol: e.target.value,
            expiry: "30-Apr-2026",
        }));
    };

    const handleExpiryChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        updateFilters("expiry", e.target.value);
    };

    useEffect(() => {
        loadExpiryDates(filters);
    }, [filters.type, filters.symbol]);

    useEffect(() => {
        if (filters.expiry) {
            loadOptionChain(filters);
        }
    }, [filters.expiry]);

    return (
        <div style={{ padding: "20px" }}>
            <h2>Option Chain Dashboard</h2>
            <OptionChainFilters
                filters={filters}
                expiryDates={expiryDates}
                typeOptions={typeOptions}
                symbolOptions={symbolOptions}
                onTypeChange={handleTypeChange}
                onSymbolChange={handleSymbolChange}
                onExpiryChange={handleExpiryChange}
                onRefresh={() => loadOptionChain(filters)}
            />
            <OptionChainTable
                loading={loading}
                optionChain={optionChain}
                fetchOptionChain={fetchOptionChain}
            />
        </div>
    );
};

export default Hero;
