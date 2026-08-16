/**
 * GSTIN parsing and check-digit verification.
 *
 * This is the single strongest deterministic signal available on a
 * non-e-invoice Indian tax invoice. A GSTIN embeds a mod-36 check character, so
 * a one-character OCR slip is caught with certainty rather than estimated. It
 * also embeds the supplier's PAN and state code, which means vendor identity and
 * the tax-head rule both derive from a verifiable string rather than a fuzzy
 * name match.
 *
 * Reference: CGST Rule 46(a).
 */

const CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** 2-digit state code, 10-character PAN, entity number, Z, check character. */
const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z][0-9A-Z][0-9A-Z]$/;

/**
 * State codes 01-38 are allocated to states and union territories; 97 is
 * "Other Territory" and 99 is Centre Jurisdiction.
 */
const VALID_STATE_CODES: ReadonlySet<string> = new Set([
  ...Array.from({ length: 38 }, (_, i) => String(i + 1).padStart(2, "0")),
  "97",
  "99",
]);

export class GstinError extends Error {}

export interface Gstin {
  readonly raw: string;
  readonly stateCode: string;
  readonly pan: string;
}

/**
 * The mod-36 check character for the first fourteen characters of a GSTIN.
 *
 * Each character's ordinal is multiplied by an alternating 1, 2 factor; the
 * quotient and remainder of that product against 36 are both accumulated.
 */
export function checkCharacter(firstFourteen: string): string {
  let total = 0;
  for (let index = 0; index < firstFourteen.length; index += 1) {
    const char = firstFourteen[index] as string;
    const ordinal = CHARSET.indexOf(char);
    if (ordinal === -1) throw new GstinError(`character outside GSTIN charset: ${char}`);
    const product = ordinal * (index % 2 === 0 ? 1 : 2);
    total += Math.floor(product / 36) + (product % 36);
  }
  return CHARSET[(36 - (total % 36)) % 36] as string;
}

/** True only if the candidate is structurally sound and its check digit holds. */
export function isValidGstin(candidate: string | null | undefined): boolean {
  if (candidate === null || candidate === undefined) return false;
  const value = candidate.trim();
  if (value.length !== 15) return false;
  if (!GSTIN_PATTERN.test(value)) return false;
  if (!VALID_STATE_CODES.has(value.slice(0, 2))) return false;
  return checkCharacter(value.slice(0, 14)) === value[14];
}

/** Parse a GSTIN, throwing rather than returning a half-trusted value. */
export function parseGstin(candidate: string): Gstin {
  const value = (candidate ?? "").trim();
  if (!isValidGstin(value)) {
    throw new GstinError(`not a valid GSTIN: ${JSON.stringify(candidate)}`);
  }
  return { raw: value, stateCode: value.slice(0, 2), pan: value.slice(2, 12) };
}
