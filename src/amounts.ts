/**
 * amounts.ts — stroops (7 decimals, the wire unit) to dollars and back, without floats.
 *
 * x402git prices in micro-dollars (6 decimals); the Stellar `accepts` entry carries
 * micro × 10, so every price is a whole number of stroops and the last digit is 0.
 */

const STROOPS_PER_UNIT = 10_000_000n;

/** `20000000n` → `"2.00"`; `12345678n` → `"1.2345678"`. At least two decimals, never a float. */
export function stroopsToDecimal(stroops: bigint): string {
  if (stroops < 0n) throw new RangeError("stroopsToDecimal: negative amount");
  const whole = stroops / STROOPS_PER_UNIT;
  let frac = (stroops % STROOPS_PER_UNIT).toString().padStart(7, "0");
  frac = frac.replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${whole}.${frac}`;
}

/** A Horizon balance string (`"4.8980000"`) → stroops. Throws on anything but digits and one point. */
export function decimalToStroops(decimal: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,7}))?$/.exec(decimal.trim());
  if (!m) throw new RangeError(`decimalToStroops: not a Stellar amount: ${decimal}`);
  const whole = BigInt(m[1]);
  const frac = BigInt((m[2] ?? "").padEnd(7, "0"));
  return whole * STROOPS_PER_UNIT + frac;
}

/** `"$2.00"`, the way the site prints a price. */
export function dollars(stroops: bigint): string {
  return `$${stroopsToDecimal(stroops)}`;
}

/** The 402's `amount` as a bigint, or null when it is not a positive integer string. */
export function parseAmount(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const n = BigInt(value);
  return n > 0n ? n : null;
}
