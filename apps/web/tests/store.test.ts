/**
 * Storage-layer behaviour, against a real embedded Postgres.
 *
 * Every case here is a defect that reached the running application once. The
 * shared shape of most of them: a rule the validation layer treats as "show a
 * human" was also encoded as a storage constraint, so the write failed and the
 * invoice became `failed` instead of reviewable — hiding exactly the violation
 * the tool exists to surface.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Route, Severity, type Finding, type InvoiceExtraction } from "@invoice-extract/core";

import { getDatabase, resetDatabase } from "../lib/db";
import {
  asInvoiceStatus,
  computeDuplicateKey,
  createInvoice,
  claimNextQueued,
  getInvoice,
  isInvoiceId,
  isoDate,
  listInvoices,
  recordReview,
  releaseStranded,
  saveResult,
} from "../lib/store";

/** A field as the pipeline hands it over: a value plus its evidence. */
function field(value: string | null) {
  return { value, grounded: "true" as const, samples: value === null ? [] : [value] };
}

/** A complete extraction, overridable per case. */
function extractionOf(overrides: Partial<Record<string, string | null>> = {}): InvoiceExtraction {
  const base: Record<string, string | null> = {
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
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(base).map(([name, value]) => [name, field(value)]),
  ) as unknown as InvoiceExtraction;
}

async function store(
  extraction: InvoiceExtraction,
  options: { findings?: Finding[]; route?: Route } = {},
) {
  const id = await createInvoice({
    storageKey: `${crypto.randomUUID()}.pdf`,
    originalName: "invoice.pdf",
    uploadedBy: "tester",
  });
  const result = await saveResult({
    id,
    extraction,
    findings: options.findings ?? [],
    decision: { route: options.route ?? Route.Review, reasons: ["test"] },
    textLayer: "text layer",
    hadTextLayer: true,
    model: "test-model",
    promptHash: "hash0001",
    rawRuns: [{ invoiceNumber: "INV/2026/0042" }],
  });
  return { id, result };
}

beforeEach(() => {
  // A fresh database per test: these assert on counts and on rows being absent.
  process.env.PGLITE_PATH = `memory://store-test-${crypto.randomUUID()}`;
  process.env.SCHEMA_PATH = new URL("../../../db/schema.sql", import.meta.url).pathname;
  resetDatabase();
});

afterEach(() => {
  resetDatabase();
});

describe("values a reviewer is meant to see", () => {
  it("stores an invoice number longer than Rule 46(b) allows", async () => {
    // Rule 46(b) caps this at sixteen characters. Twenty-four is a finding to
    // show a reviewer, not a write to refuse.
    const number = "HEW/GGN/2026-2027/000891";
    expect(number.length).toBeGreaterThan(16);

    const { id } = await store(extractionOf({ invoiceNumber: number }));

    const invoice = await getInvoice(id);
    expect(invoice?.status).toBe("awaiting_review");
    expect(invoice?.invoice_number).toBe(number);
  });

  it("stores a GSTIN that is the wrong length", async () => {
    // The mod-36 check digit exists to catch a one-character OCR slip. The slip
    // that corrupts a GSTIN is often the same one that changes its length, so a
    // char(15) column throws 22001 on precisely the input the check is for.
    const malformed = "27AAAPA1234A1Z5XXXX";
    expect(malformed.length).not.toBe(15);

    const { id } = await store(extractionOf({ supplierGstin: malformed }));

    const invoice = await getInvoice(id);
    expect(invoice?.status).toBe("awaiting_review");
    expect(invoice?.supplier_gstin).toBe(malformed);
  });

  it("stores a place of supply the model returned as a state name", async () => {
    const { id } = await store(extractionOf({ placeOfSupplyStateCode: "Maharashtra" }));

    const invoice = await getInvoice(id);
    expect(invoice?.status).toBe("awaiting_review");
    expect(invoice?.place_of_supply_state_code).toBe("Maharashtra");
  });

  it("keeps an invoice reviewable when the date is not ISO", async () => {
    // Almost every Indian invoice prints DD/MM/YYYY. Handing that to a `date`
    // column raises 22008, which turned a reviewable invoice into a failed one.
    // The column takes null; the raw string survives in field_evidence.
    const { id } = await store(extractionOf({ invoiceDate: "31/03/2024" }));

    const invoice = await getInvoice(id);
    expect(invoice?.status).toBe("awaiting_review");
    expect(invoice?.invoice_date).toBeNull();
    expect(invoice?.field_evidence.invoiceDate?.samples).toContain("31/03/2024");
  });
});

describe("saveResult", () => {
  it("records findings and raw runs for a duplicate, not just the rejection", async () => {
    // A rejected duplicate that stored neither could not be audited later or
    // re-evaluated against a new prompt, which is what extraction_run is for.
    const extraction = extractionOf();
    await store(extraction);
    const { id, result } = await store(extraction, {
      findings: [
        {
          code: "TOTAL_MISMATCH",
          severity: Severity.Error,
          field: "totalValue",
          message: "taxable plus taxes does not equal the invoice total",
        },
      ],
    });

    expect(result.status).toBe("rejected");
    expect(result.duplicateOf).not.toBeNull();

    const invoice = await getInvoice(id);
    expect(invoice?.findings.map((f) => f.code)).toContain("TOTAL_MISMATCH");

    const database = await getDatabase();
    const { rows } = await database.query<{ count: string }>(
      "select count(*) as count from extraction_run where invoice_id = $1",
      [id],
    );
    expect(Number(rows[0]?.count)).toBe(1);
  });

  it("does not treat a second invoice as a duplicate across financial years", async () => {
    // The Indian financial year runs April to March, so the same number in
    // April 2026 and in March 2026 belongs to two different years.
    await store(extractionOf({ invoiceDate: "2026-04-01" }));
    const { result } = await store(extractionOf({ invoiceDate: "2026-03-31" }));

    expect(result.status).not.toBe("rejected");
  });
});

describe("recordReview", () => {
  it("refuses to label an invoice that does not exist", async () => {
    await expect(
      recordReview({
        id: crypto.randomUUID(),
        reviewer: "tester",
        values: { invoiceNumber: "INV/2026/0099" },
        model: "test-model",
        promptHash: "hash0001",
      }),
    ).rejects.toThrow(/no invoice/);
  });

  it("discards the labels when the invoice update fails", async () => {
    // The corrections and the invoice update are one act. Committing labels for
    // a change that never landed corrupts the only ground truth this system
    // has, and a retry would insert every label a second time. Driven through
    // the transaction primitive because every value-shaped way of failing the
    // update is now handled before it reaches Postgres.
    const { id } = await store(extractionOf());
    const database = await getDatabase();

    await expect(
      database.transaction(async (tx) => {
        await tx.query(
          `insert into correction
             (invoice_id, field_name, extracted_value, corrected_value, was_correct,
              reviewer, model, prompt_hash)
           values ($1, 'invoiceNumber', 'a', 'b', false, 'tester', 'm', 'h')`,
          [id],
        );
        await tx.query("update invoice set status = 'reviewed' where id = $1", [id]);
        throw new Error("the update was refused");
      }),
    ).rejects.toThrow("the update was refused");

    const { rows } = await database.query<{ count: string }>(
      "select count(*) as count from correction where invoice_id = $1",
      [id],
    );
    expect(Number(rows[0]?.count)).toBe(0);

    const invoice = await getInvoice(id);
    expect(invoice?.status).toBe("awaiting_review");
  });

  it("writes one label per field the reviewer touched, confirmations included", async () => {
    const { id } = await store(extractionOf());

    await recordReview({
      id,
      reviewer: "tester",
      // One corrected, one confirmed as-is. Both are labels.
      values: { invoiceNumber: "INV/2026/0043", hsn: "998314" },
      model: "test-model",
      promptHash: "hash0001",
    });

    const database = await getDatabase();
    const { rows } = await database.query<{ field_name: string; was_correct: boolean }>(
      "select field_name, was_correct from correction where invoice_id = $1 order by field_name",
      [id],
    );
    expect(rows).toEqual([
      { field_name: "hsn", was_correct: true },
      { field_name: "invoiceNumber", was_correct: false },
    ]);

    const invoice = await getInvoice(id);
    expect(invoice?.status).toBe("reviewed");
    expect(invoice?.invoice_number).toBe("INV/2026/0043");
  });
});

describe("the queue", () => {
  it("returns an invoice stranded by a dead worker", async () => {
    // A worker that dies mid-extraction leaves its claim set forever, and the
    // invoice is then invisible to the queue and the review list both.
    await store(extractionOf());
    const id = await createInvoice({
      storageKey: "x.pdf",
      originalName: "x.pdf",
      uploadedBy: "tester",
    });
    const claimed = await claimNextQueued();
    expect(claimed?.id).toBe(id);

    const database = await getDatabase();
    await database.query(
      "update invoice set claimed_at = now() - interval '2 hours' where id = $1",
      [id],
    );

    expect(await releaseStranded(30)).toBe(1);
    expect((await claimNextQueued())?.id).toBe(id);
  });

  it("leaves a claim younger than the cutoff alone", async () => {
    await createInvoice({ storageKey: "y.pdf", originalName: "y.pdf", uploadedBy: "tester" });
    await claimNextQueued();

    expect(await releaseStranded(30)).toBe(0);
  });
});

describe("input at the edges", () => {
  it("rejects a status that is not one", async () => {
    // The column is an enum, so an unknown value reaches Postgres as a bad
    // literal and raises 22P02 rather than returning nothing.
    expect(asInvoiceStatus("awaiting_review")).toBe("awaiting_review");
    expect(asInvoiceStatus("nonsense")).toBeNull();
    expect(asInvoiceStatus(null)).toBeNull();
  });

  it("treats a non-uuid id as absent rather than as an error", async () => {
    expect(isInvoiceId("not-a-uuid")).toBe(false);
    expect(isInvoiceId(crypto.randomUUID())).toBe(true);
    await expect(getInvoice("not-a-uuid")).resolves.toBeNull();
  });

  it("lists by status", async () => {
    await store(extractionOf(), { route: Route.AutoApprove });
    await store(extractionOf({ invoiceNumber: "INV/2026/0043" }), { route: Route.Review });

    expect(await listInvoices("auto_approved")).toHaveLength(1);
    expect(await listInvoices("awaiting_review")).toHaveLength(1);
    expect(await listInvoices()).toHaveLength(2);
  });
});

describe("isoDate", () => {
  it("reads the calendar day the driver parsed, not the UTC one", () => {
    // Both drivers build a `date` at local midnight. East of UTC that is the
    // previous day in UTC terms, so toISOString renders 15/08 as 14/08 — and on
    // the review screen the shifted value seeds the form, so a reviewer
    // confirming an unchanged field labels the wrong date.
    const localMidnight = new Date(2026, 6, 15, 0, 0, 0);
    expect(isoDate(localMidnight)).toBe("2026-07-15");
  });
});

describe("computeDuplicateKey", () => {
  it("is null when the date is not ISO, so nothing collides on a bad parse", () => {
    expect(computeDuplicateKey(extractionOf({ invoiceDate: "31/03/2024" }))).toBeNull();
  });

  it("is null without a supplier or a number", () => {
    expect(computeDuplicateKey(extractionOf({ supplierGstin: null }))).toBeNull();
    expect(computeDuplicateKey(extractionOf({ invoiceNumber: null }))).toBeNull();
  });
});
