/**
 * GSTIN is a public seam: other subsystems key vendors on it.
 *
 * The valid fixtures are real-world GSTINs whose check digit is self-consistent.
 * The expected values are read off the string itself rather than recomputed the
 * way the implementation computes them.
 */

import { describe, expect, it } from "vitest";

import { GstinError, isValidGstin, parseGstin } from "../src/gstin.js";

const VALID = ["27AAPFU0939F1ZV", "29AAGCB7383J1Z4", "24AAACC1206D1ZM"] as const;

describe("isValidGstin", () => {
  it.each(VALID)("accepts the well-formed GSTIN %s", (gstin) => {
    expect(isValidGstin(gstin)).toBe(true);
  });

  it("rejects a single-character transposition", () => {
    // The whole point of the check digit: a one-character OCR slip is caught.
    expect(isValidGstin("27AAPFU0939F1ZW")).toBe(false);
  });

  it("rejects the wrong length", () => {
    expect(isValidGstin("27AAPFU0939F1Z")).toBe(false);
    expect(isValidGstin("27AAPFU0939F1ZVV")).toBe(false);
  });

  it("rejects lowercase", () => {
    // Accepting lowercase would let a normalisation bug through silently.
    expect(isValidGstin("27aapfu0939f1zv")).toBe(false);
  });

  it("rejects an unallocated state code", () => {
    expect(isValidGstin("00AAPFU0939F1ZV")).toBe(false);
  });

  it("rejects a malformed PAN block", () => {
    // PAN is five letters, four digits, one letter.
    expect(isValidGstin("27AAPF10939F1ZV")).toBe(false);
  });

  it("tolerates surrounding whitespace", () => {
    expect(isValidGstin("  27AAPFU0939F1ZV  ")).toBe(true);
  });

  it("rejects null and undefined without throwing", () => {
    expect(isValidGstin(null)).toBe(false);
    expect(isValidGstin(undefined)).toBe(false);
  });
});

describe("parseGstin", () => {
  it.each(VALID)("exposes the state code and PAN embedded in %s", (gstin) => {
    const parsed = parseGstin(gstin);
    expect(parsed.stateCode).toBe(gstin.slice(0, 2));
    expect(parsed.pan).toBe(gstin.slice(2, 12));
  });

  it("throws rather than returning a half-trusted value", () => {
    expect(() => parseGstin("not-a-gstin")).toThrow(GstinError);
  });
});
