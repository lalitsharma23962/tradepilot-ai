export const VALIDATION_SYMBOLS=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT'] as const;
export type ValidationSymbol=typeof VALIDATION_SYMBOLS[number];
