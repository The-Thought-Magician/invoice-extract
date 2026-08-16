/**
 * The text layer reader, run against the real fixture corpus.
 *
 * These are not mocked. `pdftotext`, `pdftoppm` and `tesseract` actually run,
 * because the thing worth testing is whether a real scan produces usable text,
 * and a mock cannot answer that.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { isGrounded } from "@invoice-extract/core";

import { PdfTextLayerReader } from "../src/textLayer";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/pdfs/", import.meta.url));

async function pdf(name: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(`${FIXTURES}${name}.pdf`));
}

const reader = new PdfTextLayerReader({ dpi: 300 });

describe("digital PDFs", () => {
  it("uses the embedded text layer", async () => {
    const result = await reader.readDetailed(await pdf("01-clean-intra-state"));
    expect(result.source).toBe("embedded");
  });

  it("grounds every printed value on a clean digital invoice", async () => {
    const text = await reader.read(await pdf("01-clean-intra-state"));
    for (const value of ["27AAPFU0939F1ZV", "INV/2026/0042", "998314", "1180.00"]) {
      expect(isGrounded(value, text), `${value} should be grounded`).toBe(true);
    }
  });

  it("does not ground a value that is not on the page", async () => {
    const text = await reader.read(await pdf("01-clean-intra-state"));
    expect(isGrounded("9999.99", text)).toBe(false);
  });
}, 60_000);

describe("scanned PDFs", () => {
  it("falls back to OCR when there is no embedded text layer", async () => {
    const result = await reader.readDetailed(await pdf("06-scan-clean-intra-state"));
    expect(result.source).toBe("ocr");
    expect(result.text.length).toBeGreaterThan(100);
  }, 60_000);

  it("recovers the total from a scan", async () => {
    const text = await reader.read(await pdf("06-scan-clean-intra-state"));
    // Printed as "Rs. 26,432.00"; grounding normalises away the separators.
    expect(isGrounded("26432.00", text)).toBe(true);
  }, 60_000);

  it("recovers the supplier GSTIN from a scan", async () => {
    const text = await reader.read(await pdf("06-scan-clean-intra-state"));
    expect(isGrounded("27AAACR5055K1Z7", text)).toBe(true);
  }, 60_000);

  it("loses the invoice number to a confusable character at 300 dpi", async () => {
    // Tesseract reads "RI-2026-0208" as "Rl-2026-0208", taking the capital I
    // for a lowercase l. The correct value then fails to ground and the
    // invoice routes to a human.
    //
    // This is the asymmetry ADR 0006 relies on. OCR noise costs reviewer time;
    // it can never promote a wrong value, because grounding only ever
    // withholds trust, never confers it.
    const text = await reader.read(await pdf("06-scan-clean-intra-state"));
    expect(isGrounded("RI-2026-0208", text)).toBe(false);
  }, 60_000);

  it("reads that same invoice number correctly at 200 dpi", async () => {
    // Resolution is not monotonic. Raising dpi fixes some characters and
    // breaks others, which is why the review rate on the scanned half has to
    // be measured against real documents rather than tuned by intuition.
    const coarse = new PdfTextLayerReader({ dpi: 200 });
    const text = await coarse.read(await pdf("06-scan-clean-intra-state"));
    expect(isGrounded("RI-2026-0208", text)).toBe(true);
  }, 60_000);
});
