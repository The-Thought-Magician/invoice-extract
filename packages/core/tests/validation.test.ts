/**
 * Validation is the seam that replaces the discarded confidence threshold.
 *
 * Every expected value here comes from CGST Rule 46 or from arithmetic done by
 * hand, never from re-running the implementation.
 */

import { describe, expect, it } from "vitest";

import { field, type Field, type InvoiceExtraction } from "../src/model";
import { Severity, validate } from "../src/validation";

const g = (value: string | null): Field => field(value, { grounded: true });

/** A clean Maharashtra-to-Maharashtra invoice. 1000 taxable, 18% split 9 and 9. */
function intraState(overrides: Partial<InvoiceExtraction> = {}): InvoiceExtraction {
  return {
    supplierGstin: g("27AAPFU0939F1ZV"),
    recipientGstin: g("27AAGCB7383J1Z8"),
    invoiceNumber: g("INV/2026/0042"),
    invoiceDate: g("2026-07-15"),
    placeOfSupplyStateCode: g("27"),
    taxableValue: g("1000.00"),
    cgstAmount: g("90.00"),
    sgstAmount: g("90.00"),
    igstAmount: g("0.00"),
    cessAmount: g("0.00"),
    totalValue: g("1180.00"),
    hsn: g("998314"),
    ...overrides,
  };
}

const codes = (extraction: InvoiceExtraction): string[] =>
  validate(extraction).map((f) => f.code);

describe("the happy path", () => {
  it("finds nothing wrong with a clean intra-state invoice", () => {
    expect(validate(intraState())).toEqual([]);
  });

  it("finds nothing wrong with a clean inter-state invoice", () => {
    // Maharashtra supplier, Karnataka place of supply, so IGST at 18 percent.
    const inter = intraState({
      placeOfSupplyStateCode: g("29"),
      recipientGstin: g("29AAGCB7383J1Z4"),
      cgstAmount: g("0.00"),
      sgstAmount: g("0.00"),
      igstAmount: g("180.00"),
    });
    expect(validate(inter)).toEqual([]);
  });
});

describe("Rule 46 mandatory particulars", () => {
  it("treats a missing supplier GSTIN as fatal", () => {
    const findings = validate(intraState({ supplierGstin: g(null) }));
    expect(findings.map((f) => f.code)).toContain("MISSING_SUPPLIER_GSTIN");
    expect(findings.some((f) => f.severity === Severity.Fatal)).toBe(true);
  });

  it("treats a missing invoice number as fatal", () => {
    expect(codes(intraState({ invoiceNumber: g(null) }))).toContain("MISSING_INVOICE_NUMBER");
  });

  it("treats a missing total as fatal", () => {
    expect(codes(intraState({ totalValue: g(null) }))).toContain("MISSING_TOTAL_VALUE");
  });

  it("does not treat a missing recipient GSTIN as fatal", () => {
    // Rule 46(d) requires it only where the recipient is registered.
    const findings = validate(intraState({ recipientGstin: g(null) }));
    expect(findings.every((f) => f.severity !== Severity.Fatal)).toBe(true);
  });
});

describe("Rule 46(b) invoice number format", () => {
  it("rejects more than sixteen characters", () => {
    expect(codes(intraState({ invoiceNumber: g("INV/2026/00000000042") }))).toContain(
      "INVOICE_NUMBER_TOO_LONG",
    );
  });

  it("rejects characters outside alphanumerics, hyphen and slash", () => {
    expect(codes(intraState({ invoiceNumber: g("INV#2026*42") }))).toContain(
      "INVOICE_NUMBER_BAD_CHARS",
    );
  });

  it("accepts exactly sixteen characters", () => {
    expect(codes(intraState({ invoiceNumber: g("ABCD/1234-5678/9") }))).not.toContain(
      "INVOICE_NUMBER_TOO_LONG",
    );
  });
});

describe("GSTIN integrity", () => {
  it("catches a supplier GSTIN whose check digit fails", () => {
    expect(codes(intraState({ supplierGstin: g("27AAPFU0939F1ZW") }))).toContain(
      "SUPPLIER_GSTIN_INVALID",
    );
  });

  it("catches a recipient GSTIN whose check digit fails", () => {
    expect(codes(intraState({ recipientGstin: g("29AAGCB7383J1Z9") }))).toContain(
      "RECIPIENT_GSTIN_INVALID",
    );
  });
});

describe("arithmetic", () => {
  it("catches a total that is not taxable plus taxes", () => {
    // 1000 + 90 + 90 is 1180, not 1200.
    expect(codes(intraState({ totalValue: g("1200.00") }))).toContain("TOTAL_MISMATCH");
  });

  it("tolerates one paisa of rounding", () => {
    expect(codes(intraState({ totalValue: g("1180.01") }))).not.toContain("TOTAL_MISMATCH");
  });

  it("does not tolerate two paise of drift", () => {
    expect(codes(intraState({ totalValue: g("1180.02") }))).toContain("TOTAL_MISMATCH");
  });

  it("catches CGST and SGST that are not equal halves", () => {
    const asymmetric = intraState({ cgstAmount: g("100.00"), sgstAmount: g("80.00") });
    expect(codes(asymmetric)).toContain("CGST_SGST_ASYMMETRY");
  });

  it("flags an implied rate that is not a GST slab", () => {
    // 130 on 1000 is 13 percent, which does not exist as a slab.
    const odd = intraState({
      cgstAmount: g("65.00"),
      sgstAmount: g("65.00"),
      totalValue: g("1130.00"),
    });
    expect(codes(odd)).toContain("IMPLAUSIBLE_TAX_RATE");
  });

  it("accepts a fractional slab rate", () => {
    // 7.5 percent on 1000 is 75, split 37.50 and 37.50.
    const fractional = intraState({
      cgstAmount: g("37.50"),
      sgstAmount: g("37.50"),
      totalValue: g("1075.00"),
    });
    expect(codes(fractional)).not.toContain("IMPLAUSIBLE_TAX_RATE");
  });

  it("catches a negative taxable value", () => {
    expect(codes(intraState({ taxableValue: g("-1000.00") }))).toContain(
      "NEGATIVE_TAXABLE_VALUE",
    );
  });

  it("reports an unparseable amount rather than coercing it", () => {
    expect(codes(intraState({ totalValue: g("Rs. 1,180/-") }))).toContain(
      "TOTAL_VALUE_NOT_NUMERIC",
    );
  });

  it("does not lose paise to floating point", () => {
    // 0.1 + 0.2 is famously not 0.3 in IEEE 754. In paise it is exact.
    const pennies = intraState({
      taxableValue: g("0.10"),
      cgstAmount: g("0.10"),
      sgstAmount: g("0.10"),
      totalValue: g("0.30"),
    });
    expect(codes(pennies)).not.toContain("TOTAL_MISMATCH");
  });
});

describe("tax head consistency", () => {
  it("catches an intra-state supply charged IGST", () => {
    const wrong = intraState({
      cgstAmount: g("0.00"),
      sgstAmount: g("0.00"),
      igstAmount: g("180.00"),
    });
    expect(codes(wrong)).toContain("WRONG_TAX_HEAD");
  });

  it("catches an inter-state supply charged CGST", () => {
    expect(codes(intraState({ placeOfSupplyStateCode: g("29") }))).toContain("WRONG_TAX_HEAD");
  });

  it("catches both heads charged at once", () => {
    expect(codes(intraState({ igstAmount: g("180.00") }))).toContain("MIXED_TAX_HEADS");
  });
});

describe("Rule 46(g) HSN", () => {
  it("rejects an HSN of an impossible length", () => {
    expect(codes(intraState({ hsn: g("99831") }))).toContain("HSN_MALFORMED");
  });

  it("rejects a non-numeric HSN", () => {
    expect(codes(intraState({ hsn: g("ABC123") }))).toContain("HSN_MALFORMED");
  });
});

describe("dates", () => {
  it("rejects a date that is not normalised to ISO 8601", () => {
    expect(codes(intraState({ invoiceDate: g("15/07/26") }))).toContain(
      "INVOICE_DATE_UNPARSEABLE",
    );
  });

  it("rejects a date that looks ISO but does not exist", () => {
    expect(codes(intraState({ invoiceDate: g("2026-02-31") }))).toContain(
      "INVOICE_DATE_UNPARSEABLE",
    );
  });

  it("accepts a real ISO date", () => {
    expect(codes(intraState({ invoiceDate: g("2026-07-15") }))).not.toContain(
      "INVOICE_DATE_UNPARSEABLE",
    );
  });
});

describe("reporting", () => {
  it("reports fatal findings before errors", () => {
    const broken = intraState({ totalValue: g(null), hsn: g("99831") });
    expect(validate(broken)[0]?.severity).toBe(Severity.Fatal);
  });

  it("names the field each finding concerns", () => {
    expect(validate(intraState({ hsn: g("99831") }))[0]?.field).toBe("hsn");
  });
});
