import { BadInputError, getDailyChain } from "./_lib/bhavcopy.js";

// GET /api/oi-history?symbol=NIFTY&expiry=13-Oct-2026&date=2026-10-09
// One trading day's end-of-day OI per strike, from the NSE F&O bhavcopy.
export default async function handler(req, res) {
  const { symbol, expiry, date } = req.query;

  try {
    const data = await getDailyChain({ symbol, expiry, date });

    if (!data) {
      return res.status(404).json({ error: "No bhavcopy for this date" });
    }

    // past trading days never change
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.status(200).json(data);
  } catch (error) {
    if (error instanceof BadInputError) {
      return res.status(400).json({ error: error.message });
    }

    console.error("Error fetching bhavcopy:", error);
    res.status(500).json({
      error: "Failed to fetch daily OI history",
      message: error.message,
    });
  }
}
