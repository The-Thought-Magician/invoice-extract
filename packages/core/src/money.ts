/**
 * Money is handled as integer paise. Floating point is never used for an
 * amount: 0.1 + 0.2 is not 0.3 in IEEE 754, and an invoice total that is wrong
 * in the last paisa is an error the tool is supposed to catch, not cause.
 */

/** Digits with at most two decimal places, optionally signed. Nothing else. */
const AMOUNT_PATTERN = /^-?\d+(\.\d{1,2})?$/;

/**
 * Parse an amount into paise, or null if it is not a bare decimal number.
 *
 * Deliberately strict. A value such as "Rs. 1,180/-" is an upstream
 * normalisation failure and must surface as a finding rather than be silently
 * coerced into 1180.
 */
export function parsePaise(value: string | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (!AMOUNT_PATTERN.test(trimmed)) return null;

  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [rupees = "0", fraction = ""] = unsigned.split(".");
  const paise = BigInt(rupees) * 100n + BigInt(fraction.padEnd(2, "0"));
  return negative ? -paise : paise;
}

export function formatPaise(paise: bigint): string {
  const negative = paise < 0n;
  const absolute = negative ? -paise : paise;
  const rupees = absolute / 100n;
  const fraction = (absolute % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${rupees}.${fraction}`;
}

export function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/**
 * The combined ad valorem rate implied by tax over taxable value, in basis
 * points, rounded half up. 1800 means 18 percent.
 */
export function impliedRateBasisPoints(tax: bigint, taxable: bigint): bigint | null {
  if (taxable <= 0n) return null;
  return (tax * 10000n * 2n + taxable) / (taxable * 2n);
}
