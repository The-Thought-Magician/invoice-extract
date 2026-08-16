/**
 * Routing is the seam the whole design turns on: which invoices a human sees.
 *
 * Self-reported model confidence is deliberately not an input.
 */

import { describe, expect, it } from "vitest";

import { field, type Field, type InvoiceExtraction } from "../src/model";
import { type DecideOptions, decide, Route } from "../src/routing";
import { validate } from "../src/validation";

const g = (value: string | null): Field => field(value, { grounded: true });

function clean(overrides: Partial<InvoiceExtraction> = {}): InvoiceExtraction {
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

const routeOf = (extraction: InvoiceExtraction, options: DecideOptions = {}): Route =>
  decide(extraction, validate(extraction), options).route;

describe("the gate", () => {
  it("auto-approves a clean invoice once the gate is open", () => {
    expect(routeOf(clean(), { coldStart: false })).toBe(Route.AutoApprove);
  });

  it("reviews everything during cold start", () => {
    expect(routeOf(clean(), { coldStart: true })).toBe(Route.Review);
  });

  it("treats cold start as the default", () => {
    expect(decide(clean(), validate(clean())).route).toBe(Route.Review);
  });
});

describe("what forces a human to look", () => {
  it("rejects on a fatal finding rather than reviewing", () => {
    // Not an invoice under Rule 46, so there is nothing to review.
    expect(routeOf(clean({ invoiceNumber: g(null) }), { coldStart: false })).toBe(Route.Reject);
  });

  it("reviews on an error finding", () => {
    expect(routeOf(clean({ hsn: g("99831") }), { coldStart: false })).toBe(Route.Review);
  });

  it("reviews an ungrounded field even when the arithmetic passes", () => {
    // A value the model produced that does not appear in the text layer is a
    // fabrication candidate no matter how well it adds up.
    const ungrounded = clean({
      supplierGstin: field("27AAPFU0939F1ZV", { grounded: false }),
    });
    expect(routeOf(ungrounded, { coldStart: false })).toBe(Route.Review);
  });

  it("reviews a field whose grounding check never ran", () => {
    // Treating unknown as passing would let an entire ungrounded batch through.
    const unknown = clean({ totalValue: field("1180.00", { grounded: "not-attempted" }) });
    expect(routeOf(unknown, { coldStart: false })).toBe(Route.Review);
  });

  it("does not demand grounding for an absent optional field", () => {
    const noRecipient = clean({ recipientGstin: field(null) });
    expect(routeOf(noRecipient, { coldStart: false })).toBe(Route.AutoApprove);
  });

  it("reviews when independent runs disagreed", () => {
    const wobbly = clean({
      totalValue: field("1180.00", {
        grounded: true,
        samples: ["1180.00", "1180.00", "1130.00"],
      }),
    });
    expect(routeOf(wobbly, { coldStart: false })).toBe(Route.Review);
  });

  it("does not review when independent runs agreed", () => {
    const steady = clean({
      totalValue: field("1180.00", {
        grounded: true,
        samples: ["1180.00", "1180.00", "1180.00"],
      }),
    });
    expect(routeOf(steady, { coldStart: false })).toBe(Route.AutoApprove);
  });

  it("reviews an audit sample of otherwise clean invoices", () => {
    const decision = decide(clean(), validate(clean()), {
      coldStart: false,
      sampleForAudit: true,
    });
    expect(decision.route).toBe(Route.Review);
    expect(decision.reasons.some((r) => r.includes("audit"))).toBe(true);
  });
});

describe("explainability", () => {
  it("names the failing field in its reasons", () => {
    const broken = clean({ hsn: g("99831") });
    const decision = decide(broken, validate(broken), { coldStart: false });
    expect(decision.reasons.some((r) => r.includes("hsn"))).toBe(true);
  });

  it("gives a reason even when auto-approving", () => {
    expect(decide(clean(), validate(clean()), { coldStart: false }).reasons.length).toBeGreaterThan(0);
  });
});
