import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { BadInputError, getDailyChain } from "./api/_lib/bhavcopy.js";

// Vite's dev server doesn't execute Vercel serverless functions (api/*.js) -
// it just serves their source as static text. This mirrors api/option-chain.js
// so `npm run dev` fetches real NSE data too, not just production on Vercel.
function nseOptionChainDevMiddleware(): Plugin {
    return {
        name: "nse-option-chain-dev-middleware",
        configureServer(server) {
            server.middlewares.use("/api/option-chain", async (req, res) => {
                const url = new URL(req.url ?? "", "http://localhost");
                const type = url.searchParams.get("type");
                const symbol = url.searchParams.get("symbol");
                const expiry = url.searchParams.get("expiry");

                if (!type || !symbol || !expiry) {
                    res.statusCode = 400;
                    res.setHeader("Content-Type", "application/json");
                    res.end(
                        JSON.stringify({
                            error: "Missing required parameters: type, symbol, expiry",
                        })
                    );
                    return;
                }

                try {
                    const nseUrl = `https://www.nseindia.com/api/option-chain-v3?type=${encodeURIComponent(type)}&symbol=${encodeURIComponent(symbol)}&expiry=${encodeURIComponent(expiry)}`;

                    const response = await fetch(nseUrl, {
                        method: "GET",
                        headers: {
                            "User-Agent":
                                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                            Accept: "application/json",
                            "Accept-Language": "en-US,en;q=0.9",
                            Referer: "https://www.nseindia.com/",
                        },
                    });

                    if (!response.ok) {
                        throw new Error(`NSE API responded with status ${response.status}`);
                    }

                    const data = await response.json();

                    res.statusCode = 200;
                    res.setHeader("Content-Type", "application/json");
                    res.end(JSON.stringify(data));
                } catch (error) {
                    console.error("Error fetching from NSE:", error);
                    res.statusCode = 500;
                    res.setHeader("Content-Type", "application/json");
                    res.end(
                        JSON.stringify({
                            error: "Failed to fetch option chain data",
                            message: error instanceof Error ? error.message : String(error),
                        })
                    );
                }
            });
        },
    };
}

// Mirrors api/oi-history.js (daily end-of-day OI from the NSE bhavcopy) for `npm run dev`.
function oiHistoryDevMiddleware(): Plugin {
    return {
        name: "oi-history-dev-middleware",
        configureServer(server) {
            server.middlewares.use("/api/oi-history", async (req, res) => {
                const url = new URL(req.url ?? "", "http://localhost");
                res.setHeader("Content-Type", "application/json");

                try {
                    const data = await getDailyChain({
                        symbol: url.searchParams.get("symbol"),
                        expiry: url.searchParams.get("expiry"),
                        date: url.searchParams.get("date"),
                    });

                    if (!data) {
                        res.statusCode = 404;
                        res.end(JSON.stringify({ error: "No bhavcopy for this date" }));
                        return;
                    }

                    res.statusCode = 200;
                    res.end(JSON.stringify(data));
                } catch (error) {
                    const bad = error instanceof BadInputError;
                    if (!bad) console.error("Error fetching bhavcopy:", error);
                    res.statusCode = bad ? 400 : 500;
                    res.end(
                        JSON.stringify({
                            error: bad ? (error as Error).message : "Failed to fetch daily OI history",
                            message: error instanceof Error ? error.message : String(error),
                        })
                    );
                }
            });
        },
    };
}

export default defineConfig({
    plugins: [react(), nseOptionChainDevMiddleware(), oiHistoryDevMiddleware()],

    server: {
        proxy: {
            // NSE
            "/api/nse": {
                target: "https://www.nseindia.com",
                changeOrigin: true,
                secure: true,
                rewrite: (path) =>
                    path.replace(/^\/api\/nse/, ""),
            },

            // MCX
            "/api/mcx": {
                target: "https://www.mcxindia.com",
                changeOrigin: true,
                secure: true,
                rewrite: (path) =>
                    path.replace(/^\/api\/mcx/, ""),
            },
        },
    },
});