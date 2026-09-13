class OptionChainService {
    constructor() {
        this.baseUrl = "/api/option-chain";
    }

    /**
     * Validate required params
     */
    validateRequiredParams(params = {}) {
        const requiredFields = ["type", "symbol", "expiry"];

        for (const field of requiredFields) {
            if (
                params[field] === undefined ||
                params[field] === null ||
                params[field] === ""
            ) {
                throw new Error(
                    `Missing required query parameter: "${field}". Required params are: type, symbol, expiry`
                );
            }
        }
    }

    /**
     * Build query string dynamically
     * Example:
     * /api/option-chain-v3?type=Indices&symbol=NIFTY&expiry=30-Apr-2026
     */
    buildQuery(params = {}) {
        this.validateRequiredParams(params);

        const query = new URLSearchParams();

        Object.entries(params).forEach(([key, value]) => {
            query.append(key, value);
        });

        return `${this.baseUrl}?${query.toString()}`;
    }

    /**
     * Generic fetch helper
     */
    async request(params = {}) {
        try {
            const url = this.buildQuery(params);

            const response = await fetch(url, {
                method: "GET",
                headers: {
                    "Content-Type": "application/json",
                },
            });

            console.log("Request URL:", url);
            // console.log("Response from API:", response);

            if (!response.ok) {
                throw new Error(`HTTP error! Status: ${response.status}`);
            }

            return await response.json();
        } catch (error) {
            console.error("Error fetching option chain data:", error);
            throw error;
        }
    }

    /**
     * Fetch full option chain
     * All query params are required
     */
    async fetchOptionChainData({
        type,
        symbol,
        expiry,
    } = {}) {
        return await this.request({
            type,
            symbol,
            expiry,
        });
    }

    /**
     * Fetch expiry dates
     * All query params are required
     */
    async fetchExpiryDates({
        type,
        symbol,
        expiry,
    } = {}) {
        const data = await this.request({
            type,
            symbol,
            expiry,
        });

        console.log("Fetched data for expiry dates:", data);

        return data?.records?.expiryDates || [];
    }

    /**
     * Fetch only strike data
     * All query params are required
     */
    async fetchStrikeData({
        type,
        symbol,
        expiry,
    } = {}) {
        const data = await this.fetchOptionChainData({
            type,
            symbol,
            expiry,
        });

        return data?.records?.data || [];
    }

    /**
     * Fetch formatted option chain
     * All query params are required
     */
    async fetchFormattedOptionChain({
        type,
        symbol,
        expiry,
    } = {}) {
        const data = await this.fetchOptionChainData({
            type,
            symbol,
            expiry,
        });

        const records = data?.records?.data || [];

        return records.map((item) => ({
            strikePrice: item.CE?.strikePrice ?? item.PE?.strikePrice,
            expiryDate: item.expiryDates,
            CE: item.CE || null,
            PE: item.PE || null,
        }));
    }

    /**
     * Fetch by symbol and expiry
     * All query params are required
     */
    async fetchBySymbolAndExpiry({
        type,
        symbol,
        expiry,
    } = {}) {
        return await this.fetchOptionChainData({
            type,
            symbol,
            expiry,
        });
    }
}

export default new OptionChainService();