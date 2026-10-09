// One conversion for display and explicit editors. Events retain integer minor units.
const zeroDecimal = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'UYI', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
const threeDecimal = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);
export function currencyFractionDigits(currency: string): number {
  const code = currency.toUpperCase();
  return zeroDecimal.has(code) ? 0 : threeDecimal.has(code) ? 3 : ['CLF', 'UYW'].includes(code) ? 4 : 2;
}
export const quoteMajorUnits = (amount: number, currency: string) => amount / 10 ** currencyFractionDigits(currency);
export function parseQuoteAmount(text: string, currency: string): number | null {
  const digits = currencyFractionDigits(currency), match = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!match || (match[2]?.length ?? 0) > digits) return null;
  const amount = Number(`${match[1]}${(match[2] ?? '').padEnd(digits, '0')}`);
  return Number.isSafeInteger(amount) ? amount : null;
}
