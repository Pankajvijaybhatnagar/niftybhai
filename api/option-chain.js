export default async function handler(req, res) {
  const { type, symbol, expiry } = req.query;

  // Validate required params
  if (!type || !symbol || !expiry) {
    return res.status(400).json({
      error: "Missing required parameters: type, symbol, expiry",
    });
  }

  try {
    const nseUrl = `https://www.nseindia.com/api/option-chain-v3?type=${encodeURIComponent(type)}&symbol=${encodeURIComponent(symbol)}&expiry=${encodeURIComponent(expiry)}`;

    // Set proper headers to mimic browser request
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

    // Set CORS headers
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,PATCH,DELETE,POST,PUT");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version"
    );
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");

    res.status(200).json(data);
  } catch (error) {
    console.error("Error fetching from NSE:", error);

    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS,PATCH,DELETE,POST,PUT");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version"
    );

    res.status(500).json({
      error: "Failed to fetch option chain data",
      message: error.message,
    });
  }
}
