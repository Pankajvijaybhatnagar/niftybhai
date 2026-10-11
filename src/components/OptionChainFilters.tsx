import React from "react";

type FilterType = "Indices" | "Stocks";

interface Filters {
    type: FilterType;
    symbol: string;
    expiry: string;
}

interface Props {
    filters: Filters;
    expiryDates: string[];
    typeOptions: FilterType[];
    symbolOptions: Record<FilterType, string[]>;
    onTypeChange: React.ChangeEventHandler<HTMLSelectElement>;
    onSymbolChange: React.ChangeEventHandler<HTMLSelectElement>;
    onExpiryChange: React.ChangeEventHandler<HTMLSelectElement>;
    onRefresh: () => void;
}

const OptionChainFilters: React.FC<Props> = ({
    filters,
    expiryDates,
    typeOptions,
    symbolOptions,
    onTypeChange,
    onSymbolChange,
    onExpiryChange,
    onRefresh,
}) => {
    return (
        <div className="dash-filters">
            <div className="dash-field">
                <label htmlFor="oc-type">Type</label>
                <select id="oc-type" value={filters.type} onChange={onTypeChange}>
                    {typeOptions.map((item) => (
                        <option key={item} value={item}>
                            {item}
                        </option>
                    ))}
                </select>
            </div>

            <div className="dash-field">
                <label htmlFor="oc-symbol">Symbol</label>
                <select id="oc-symbol" value={filters.symbol} onChange={onSymbolChange}>
                    {symbolOptions[filters.type].map((item) => (
                        <option key={item} value={item}>
                            {item}
                        </option>
                    ))}
                </select>
            </div>

            <div className="dash-field">
                <label htmlFor="oc-expiry">Expiry</label>
                <select id="oc-expiry" value={filters.expiry} onChange={onExpiryChange}>
                    {expiryDates.map((item) => (
                        <option key={item} value={item}>
                            {item}
                        </option>
                    ))}
                </select>
            </div>

            <button type="button" className="dash-btn" onClick={onRefresh}>
                Refresh
            </button>
        </div>
    );
};

export default OptionChainFilters;
