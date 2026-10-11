import zlib from "node:zlib";

// NSE F&O end-of-day bhavcopy: one zip per trading day with every contract's
// closing OI, change in OI, volume and price. Used for the 1W / 1M OI views.
// Files under api/_lib are not exposed as Vercel routes.

const MONTHS = {
    Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
    Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};

export class BadInputError extends Error {}

/** "13-Oct-2026" -> "2026-10-13" */
export function toIsoExpiry(expiry) {
    const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String(expiry || ""));
    if (!m) return null;
    const month = MONTHS[m[2][0].toUpperCase() + m[2].slice(1).toLowerCase()];
    return month ? `${m[3]}-${month}-${m[1].padStart(2, "0")}` : null;
}

/** Inflate the first file of a zip archive (read via the central directory). */
function unzipFirst(buf) {
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw new Error("Invalid zip: no end of central directory");

    const cd = buf.readUInt32LE(eocd + 16);
    if (buf.readUInt32LE(cd) !== 0x02014b50) throw new Error("Invalid zip: bad central directory");

    const method = buf.readUInt16LE(cd + 10);
    const compressedSize = buf.readUInt32LE(cd + 20);
    const localOffset = buf.readUInt32LE(cd + 42);

    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("Invalid zip: bad local header");
    const nameLen = buf.readUInt16LE(localOffset + 26);
    const extraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + nameLen + extraLen;
    const data = buf.subarray(start, start + compressedSize);

    if (method === 0) return data;
    if (method === 8) return zlib.inflateRawSync(data);
    throw new Error(`Unsupported zip compression method ${method}`);
}

// a few recent days of raw CSV, so several symbols/expiries reuse one download
const csvCache = new Map();
const CSV_CACHE_SIZE = 6;

function loadCsv(date) {
    if (csvCache.has(date)) return csvCache.get(date);

    const ymd = date.replaceAll("-", "");
    const url = `https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_${ymd}_F_0000.csv.zip`;

    const pending = (async () => {
        const response = await fetch(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                Referer: "https://www.nseindia.com/",
            },
        });
        // no file = holiday, weekend, or not published yet
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`NSE archive responded with status ${response.status}`);
        return unzipFirst(Buffer.from(await response.arrayBuffer())).toString("utf8");
    })();

    csvCache.set(date, pending);
    pending.catch(() => csvCache.delete(date));
    while (csvCache.size > CSV_CACHE_SIZE) csvCache.delete(csvCache.keys().next().value);
    return pending;
}

/**
 * One day's closing option chain for a symbol + expiry, in the same units as
 * the live chain (OI in contracts: bhavcopy OI is in shares, so / lot size).
 * Returns null when NSE has no file for that date.
 */
export async function getDailyChain({ symbol, expiry, date }) {
    const sym = String(symbol || "").toUpperCase();
    const isoExpiry = toIsoExpiry(expiry);
    if (!/^[A-Z0-9&-]{1,20}$/.test(sym)) throw new BadInputError("Invalid symbol");
    if (!isoExpiry) throw new BadInputError("Invalid expiry, expected e.g. 13-Oct-2026");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) throw new BadInputError("Invalid date, expected YYYY-MM-DD");

    const csv = await loadCsv(date);
    if (!csv) return null;

    const lines = csv.split(/\r?\n/);
    const header = lines[0].split(",");
    const col = (name) => {
        const i = header.indexOf(name);
        if (i < 0) throw new Error(`Bhavcopy column missing: ${name}`);
        return i;
    };
    const iSym = col("TckrSymb");
    const iExp = col("XpryDt");
    const iStrike = col("StrkPric");
    const iType = col("OptnTp");
    const iClose = col("ClsPric");
    const iSpot = col("UndrlygPric");
    const iOI = col("OpnIntrst");
    const iChg = col("ChngInOpnIntrst");
    const iVol = col("TtlTradgVol");
    const iLot = col("NewBrdLotQty");

    const byStrike = new Map();
    let spot = 0;

    for (let n = 1; n < lines.length; n++) {
        const c = lines[n].split(",");
        if (c[iSym] !== sym || c[iExp] !== isoExpiry) continue;
        const type = c[iType];
        if (type !== "CE" && type !== "PE") continue;

        const strike = Number(c[iStrike]);
        const lot = Number(c[iLot]) || 1;
        const row = byStrike.get(strike) ?? {
            strike, ceOI: 0, peOI: 0, ceChg: 0, peChg: 0, ceVol: 0, peVol: 0, ceLTP: 0, peLTP: 0,
        };

        const oi = Math.round(Number(c[iOI]) / lot);
        const chg = Math.round(Number(c[iChg]) / lot);
        const vol = Number(c[iVol]) || 0;
        const close = Number(c[iClose]) || 0;

        if (type === "CE") Object.assign(row, { ceOI: oi, ceChg: chg, ceVol: vol, ceLTP: close });
        else Object.assign(row, { peOI: oi, peChg: chg, peVol: vol, peLTP: close });

        byStrike.set(strike, row);
        spot = Number(c[iSpot]) || spot;
    }

    return {
        date,
        spot,
        rows: [...byStrike.values()].sort((a, b) => a.strike - b.strike),
    };
}
