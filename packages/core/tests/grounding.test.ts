/**
 * Grounding a value the extractor deliberately reformatted.
 *
 * The date is the case that matters. Indian invoices print DD/MM/YYYY and the
 * extractor normalises to ISO 8601, so the canonical value is never literally
 * on the page. Comparing it literally marks every invoice ungrounded, which
 * destroys the signal by firing on all of them.
 */

import { describe, expect, it } from "vitest";

import { isFieldGrounded, isGrounded } from "../src/pipeline";

describe("dates", () => {
  it("grounds an ISO date printed as DD/MM/YYYY", () => {
    expect(isFieldGrounded("invoiceDate", "2026-07-15", "Date: 15/07/2026")).toBe(true);
  });

  it("grounds an ISO date printed as DD-MM-YYYY", () => {
    expect(isFieldGrounded("invoiceDate", "2026-07-15", "Date: 15-07-2026")).toBe(true);
  });

  it("grounds an ISO date printed without leading zeros", () => {
    expect(isFieldGrounded("invoiceDate", "2026-07-05", "Date: 5/7/2026")).toBe(true);
  });

  it("grounds an ISO date printed with a short month name", () => {
    expect(isFieldGrounded("invoiceDate", "2026-07-15", "Date: 15 Jul 2026")).toBe(true);
  });

  it("grounds an ISO date printed as ISO", () => {
    expect(isFieldGrounded("invoiceDate", "2026-07-15", "Date: 2026-07-15")).toBe(true);
  });

  it("does not ground a date that is on no reading of the page", () => {
    expect(isFieldGrounded("invoiceDate", "2026-07-15", "Date: 16/07/2026")).toBe(false);
  });

  it("does not ground a day and month the extractor swapped", () => {
    // 2026-05-07 would print as 07/05/2026. The page says 15/07/2026.
    expect(isFieldGrounded("invoiceDate", "2026-05-07", "Date: 15/07/2026")).toBe(false);
  });

  it("does not ground a malformed date at all", () => {
    expect(isFieldGrounded("invoiceDate", "15/07/26", "Date: 15/07/2026")).toBe(false);
  });
});

describe("other fields are unaffected", () => {
  it("still grounds an amount through thousands separators", () => {
    expect(isFieldGrounded("totalValue", "1180.00", "Total Rs. 1,180.00")).toBe(true);
  });

  it("still refuses an amount that is not on the page", () => {
    expect(isFieldGrounded("totalValue", "1190.00", "Total Rs. 1,180.00")).toBe(false);
  });

  it("leaves the literal helper alone for callers that want it", () => {
    expect(isGrounded("2026-07-15", "Date: 15/07/2026")).toBe(false);
  });
});
