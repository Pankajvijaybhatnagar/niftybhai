class CrudeOilServices {
    constructor() {
        this.crudeOilData = [];
        this.baseUrl = "/api/mcx";
    }

    /**
     * Fetch raw MCX option chain page
     */
    async fetchMCXHTML() {
        try {
            const response = await fetch(
                `${this.baseUrl}/market-data/option-chain`
            );

            if (!response.ok) {
                throw new Error(
                    `HTTP Error: ${response.status}`
                );
            }

            return await response.text();
        } catch (error) {
            console.error("Error fetching MCX HTML:", error);
            throw error;
        }
    }

    /**
     * Extract vTick JSON from HTML
     */
extractVTickData(html) {
    try {
        console.log("HTML Response:", html);

        if (!html || typeof html !== "string") {
            throw new Error("Invalid HTML response");
        }

        // Flexible regex
        const vTickMatch = html.match(
            /vTick\s*=\s*(\[[\s\S]*?\]);/
        );

        if (!vTickMatch || !vTickMatch[1]) {
            console.error(
                "vTick not found in HTML:",
                html.substring(0, 1000)
            );

            return [];
        }

        return JSON.parse(vTickMatch[1]);
    } catch (error) {
        console.error(
            "Error extracting vTick:",
            error
        );

        return [];
    }
}
    /**
     * Get full MCX option chain ticker data
     */
    async getMCXOptionTickers() {
        try {
            const html = await this.fetchMCXHTML();

            const vTick = this.extractVTickData(html);

            return {
                vTick,
            };
        } catch (error) {
            console.error(
                "Error fetching MCX option tickers:",
                error
            );
            throw error;
        }
    }

    /**
     * Get expiry dates for symbol
     * Example:
     * GOLD
     * CRUDEOIL
     * SILVERM
     */
    async getMCXExpiriesForSymbol(symbol) {
        try {
            const { vTick } =
                await this.getMCXOptionTickers();

            const expiries = vTick
                .filter(
                    (item) =>
                        item.SymbolValue ===
                        symbol.toUpperCase()
                )
                .map((item) => item.ExpiryDate)
                .filter(Boolean);

            const uniqueExpiries = [
                ...new Set(expiries),
            ].sort();

            if (uniqueExpiries.length === 0) {
                throw new Error(
                    `No expiry dates found for symbol: ${symbol}`
                );
            }

            return {
                symbol: symbol.toUpperCase(),
                expiries: uniqueExpiries,
                totalCount: uniqueExpiries.length,
            };
        } catch (error) {
            console.error(
                "Error fetching MCX expiries:",
                error
            );
            throw error;
        }
    }

    /**
     * Get only expiry array
     */
    async getExpiriesArray(symbol) {
        const result =
            await this.getMCXExpiriesForSymbol(symbol);

        return result.expiries;
    }

    /**
     * Fetch option chain data by symbol + expiry
     */
    async fetchOptionChainData({
        symbol,
        expiry,
    } = {}) {
        try {
            const { vTick } =
                await this.getMCXOptionTickers();

            const filteredData = vTick.filter(
                (item) =>
                    item.SymbolValue ===
                    symbol.toUpperCase() &&
                    item.ExpiryDate === expiry
            );

            return {
                records: {
                    data: filteredData,
                },
            };
        } catch (error) {
            console.error(
                "Error fetching option chain data:",
                error
            );
            throw error;
        }
    }

    /**
     * Formatted option chain
     */
    async fetchFormattedOptionChain({
        symbol,
        expiry,
    } = {}) {
        const data =
            await this.fetchOptionChainData({
                symbol,
                expiry,
            });

        const records =
            data?.records?.data || [];

        return records.map((item) => ({
            strikePrice:
                item.StrikePrice ||
                item.strikePrice,

            expiryDate:
                item.ExpiryDate,

            CE: item.CE || null,

            PE: item.PE || null,
        }));
    }


    /**
 * Fetch MCX Option Chain using POST API
 * Endpoint:
 * https://www.mcxindia.com/backpage.aspx/GetOptionChain
 */
    async fetchMCXOptionChain({
        commodity,
        expiry,
    } = {}) {
        try {
            if (!commodity || !expiry) {
                throw new Error(
                    "commodity and expiry are required"
                );
            }

            const response = await fetch(
                `${this.baseUrl}/backpage.aspx/GetOptionChain`,
                {
                    method: "POST",

                    headers: {
                        "Content-Type": "application/json",
                    },

                    body: JSON.stringify({
                        Commodity: commodity.toUpperCase(),
                        Expiry: expiry,
                    }),
                }
            );

            if (!response.ok) {
                throw new Error(
                    `HTTP Error: ${response.status}`
                );
            }

            const data = await response.json();

            return data;
        } catch (error) {
            console.error(
                "Error fetching MCX option chain:",
                error
            );

            throw error;
        }
    }
}

export default new CrudeOilServices();