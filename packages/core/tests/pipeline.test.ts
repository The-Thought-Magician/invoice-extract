/**
 * Pipeline orchestration, tested through its public seam with the two outside
 * world dependencies stubbed. No PDF, no OCR binary, no API key.
 */

import { describe, expect, it } from "vitest";

import {
  type ExtractionRun,
  duplicateKey,
  isGrounded,
  mergeRuns,
  processInvoice,
} from "../src/pipeline";
import { Route } from "../src/routing";

const CLEAN_RUN: ExtractionRun = {
  supplierGstin: "27AAPFU0939F1ZV",
  recipientGstin: "27AAGCB7383J1Z8",
  invoiceNumber: "INV/2026/0042",
  invoiceDate: "2026-07-15",
  placeOfSupplyStateCode: "27",
  taxableValue: "1000.00",
  cgstAmount: "90.00",
  sgstAmount: "90.00",
  igstAmount: "0.00",
  cessAmount: "0.00",
  totalValue: "1180.00",
  hsn: "998314",
};

const TEXT_LAYER = [
  "TAX INVOICE",
  "GSTIN: 27AAPFU0939F1ZV",
  "Buyer GSTIN: 27AAGCB7383J1Z8",
  "Invoice No: INV/2026/0042   Date: 2026-07-15",
  "Place of Supply: 27 Maharashtra",
  "HSN 998314",
  "Taxable Value  Rs. 1,000.00",
  "CGST 9%  Rs. 90.00      SGST 9%  Rs. 90.00",
  "IGST  0.00   Cess  0.00",
  "Total  Rs. 1,180.00",
].join("\n");

function pipeline(runs: readonly ExtractionRun[], textLayer = TEXT_LAYER) {
  return {
    textLayerReader: { read: async () => textLayer },
    extractor: {
      extract: (() => {
        let index = 0;
        return async () => runs[index++ % runs.length] as ExtractionRun;
      })(),
    },
    runs: runs.length,
  };
}

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

describe("grounding", () => {
  it("matches through thousands separators and currency prefixes", () => {
    expect(isGrounded("1180.00", "Total Rs. 1,180.00")).toBe(true);
  });

  it("does not match a value that is not on the page", () => {
    expect(isGrounded("1190.00", "Total Rs. 1,180.00")).toBe(false);
  });

  it("does not ground an empty value", () => {
    expect(isGrounded("", "anything")).toBe(false);
  });
});

describe("merging independent runs", () => {
  it("reports the modal value when runs disagree", () => {
    const odd: ExtractionRun = { ...CLEAN_RUN, totalValue: "1130.00" };
    const merged = mergeRuns([CLEAN_RUN, CLEAN_RUN, odd], TEXT_LAYER);
    expect(merged.totalValue.value).toBe("1180.00");
  });

  it("preserves the disagreement rather than hiding it", () => {
    const odd: ExtractionRun = { ...CLEAN_RUN, totalValue: "1130.00" };
    const merged = mergeRuns([CLEAN_RUN, CLEAN_RUN, odd], TEXT_LAYER);
    expect(merged.totalValue.samples).toEqual(["1180.00", "1180.00", "1130.00"]);
  });

  it("marks a value absent from the text layer as ungrounded", () => {
    const fabricated: ExtractionRun = { ...CLEAN_RUN, totalValue: "9999.00" };
    const merged = mergeRuns([fabricated], "Total Rs. 1,180.00");
    expect(merged.totalValue.grounded).toBe(false);
  });

  it("leaves a field the model never returned as absent", () => {
    const partial: ExtractionRun = { ...CLEAN_RUN, hsn: null };
    const merged = mergeRuns([partial], TEXT_LAYER);
    expect(merged.hsn.value).toBeNull();
  });
});

describe("processInvoice", () => {
  it("auto-approves a clean, grounded, unanimous extraction once the gate is open", async () => {
    const result = await processInvoice(PDF, pipeline([CLEAN_RUN, CLEAN_RUN, CLEAN_RUN]), {
      coldStart: false,
    });
    expect(result.findings).toEqual([]);
    expect(result.decision.route).toBe(Route.AutoApprove);
  });

  it("sends a disagreeing extraction to review", async () => {
    const odd: ExtractionRun = { ...CLEAN_RUN, totalValue: "1130.00" };
    const result = await processInvoice(PDF, pipeline([CLEAN_RUN, CLEAN_RUN, odd]), {
      coldStart: false,
    });
    expect(result.decision.route).toBe(Route.Review);
  });

  it("rejects a document missing a Rule 46 particular", async () => {
    const notAnInvoice: ExtractionRun = { ...CLEAN_RUN, invoiceNumber: null };
    const result = await processInvoice(PDF, pipeline([notAnInvoice]), { coldStart: false });
    expect(result.decision.route).toBe(Route.Reject);
  });

  it("reviews everything when the text layer is empty", async () => {
    // A scan whose OCR produced nothing cannot ground anything, so nothing is
    // eligible for auto-approval. This is the failure mode on half the corpus.
    const result = await processInvoice(PDF, pipeline([CLEAN_RUN], ""), { coldStart: false });
    expect(result.decision.route).toBe(Route.Review);
  });
});

describe("duplicateKey", () => {
  it("puts July 2026 in financial year 2026-2027", () => {
    expect(duplicateKey("27AAPFU0939F1ZV", "INV/1", "2026-07-15")).toContain("FY2026-2027");
  });

  it("puts February 2026 in financial year 2025-2026", () => {
    // The Indian financial year runs April to March.
    expect(duplicateKey("27AAPFU0939F1ZV", "INV/1", "2026-02-15")).toContain("FY2025-2026");
  });

  it("separates the same invoice number from different suppliers", () => {
    const a = duplicateKey("27AAPFU0939F1ZV", "INV/1", "2026-07-15");
    const b = duplicateKey("29AAGCB7383J1Z4", "INV/1", "2026-07-15");
    expect(a).not.toBe(b);
  });
});
