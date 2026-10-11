export interface DailyChainRow {
    strike: number;
    ceOI: number;
    peOI: number;
    ceChg: number;
    peChg: number;
    ceVol: number;
    peVol: number;
    ceLTP: number;
    peLTP: number;
}

export interface DailyChain {
    date: string;
    spot: number;
    rows: DailyChainRow[];
}

export class BadInputError extends Error {}

export function toIsoExpiry(expiry: unknown): string | null;

export function getDailyChain(params: {
    symbol: unknown;
    expiry: unknown;
    date: unknown;
}): Promise<DailyChain | null>;
