/**
 * End to end over the ten fixture invoices.
 *
 * The server runs with recorded extraction answers, so the suite is
 * deterministic and needs no API key. Everything after extraction is real:
 * Tesseract actually OCRs the five scans, validation actually runs, routing
 * actually decides, and the database is a real Postgres.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

const ROOT = resolve(__dirname, "../../../") + "/";
const FIXTURES = `${ROOT}fixtures/`;

interface Expectation {
  slug: string;
  file: string;
  scanned: boolean;
  expect: { route: string; codes: string[] };
  truth: Record<string, string | null>;
}

const expectations: Expectation[] = JSON.parse(
  readFileSync(`${FIXTURES}expected.json`, "utf8"),
) as Expectation[];

const bySlug = (slug: string): Expectation => {
  const found = expectations.find((entry) => entry.slug === slug);
  if (!found) throw new Error(`no fixture ${slug}`);
  return found;
};

async function upload(page: Page, slugs: string[]): Promise<void> {
  await page.goto("/");
  await page.setInputFiles(
    '[data-testid="file-input"]',
    slugs.map((slug) => `${FIXTURES}pdfs/${slug}.pdf`),
  );
  await expect(page.locator('[data-testid="upload-status"]')).toHaveAttribute(
    "data-phase",
    "done",
    { timeout: 150_000 },
  );
  await page.reload();
}

async function openInvoice(page: Page, slug: string): Promise<void> {
  await page.goto("/");
  await page.locator(`[data-testid="row-${slug}.pdf"] a`).first().click();
  await expect(page.locator('[data-testid="review-form"]')).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test("uploads the whole corpus and routes every invoice as expected", async ({ page }) => {
  await upload(
    page,
    expectations.map((entry) => entry.slug),
  );

  await expect(page.locator('[data-testid="invoice-table"] tbody tr')).toHaveCount(10);

  const statusFor: Record<string, string> = {
    auto_approve: "auto_approved",
    review: "awaiting_review",
    reject: "rejected",
  };

  for (const entry of expectations) {
    const row = page.locator(`[data-testid="row-${entry.slug}.pdf"]`);
    const expectedStatus = statusFor[entry.expect.route] as string;
    await expect(
      row.locator(`[data-testid="status-${expectedStatus}"]`),
      `${entry.slug} should be ${expectedStatus}`,
    ).toBeVisible();
  }
});

test("labels each invoice as digital or scanned from what was actually found", async ({
  page,
}) => {
  await page.goto("/");
  for (const entry of expectations) {
    const row = page.locator(`[data-testid="row-${entry.slug}.pdf"]`);
    await expect(row).toContainText(entry.scanned ? "scan" : "digital");
  }
});

test("extracts the printed values off a clean digital invoice", async ({ page }) => {
  const entry = bySlug("01-clean-intra-state");
  await openInvoice(page, entry.slug);

  for (const [field, value] of Object.entries(entry.truth)) {
    if (value === null) continue;
    await expect(
      page.locator(`[data-testid="input-${field}"]`),
      `${field} should read ${value}`,
    ).toHaveValue(value);
  }
});

test("auto-approves a clean invoice and says why", async ({ page }) => {
  await openInvoice(page, "01-clean-intra-state");
  await expect(page.locator('[data-testid="status-auto_approved"]')).toBeVisible();
  await expect(page.locator('[data-testid="reasons"]')).toContainText(
    "all deterministic checks passed",
  );
});

test("catches an invoice number longer than Rule 46(b) allows", async ({ page }) => {
  await openInvoice(page, "04-invoice-number-too-long");
  await expect(page.locator('[data-testid="finding-INVOICE_NUMBER_TOO_LONG"]')).toBeVisible();
  await expect(page.locator('[data-testid="status-awaiting_review"]')).toBeVisible();
});

test("catches a total the document itself got wrong", async ({ page }) => {
  // The model reported what is printed. Grounding passes, because the wrong
  // total really is on the page. Only arithmetic can catch this.
  await openInvoice(page, "05-total-mismatch");
  await expect(page.locator('[data-testid="finding-TOTAL_MISMATCH"]')).toBeVisible();
  await expect(page.locator('[data-testid="ungrounded-totalValue"]')).toHaveCount(0);
});

test("catches independent runs disagreeing on a value", async ({ page }) => {
  await openInvoice(page, "03-five-percent-slab");
  await expect(page.locator('[data-testid="disagreed-totalValue"]')).toBeVisible();
  await expect(page.locator('[data-testid="reasons"]')).toContainText(
    "independent extraction runs disagreed",
  );
});

test("catches a value that is not on the page even when every run agrees", async ({ page }) => {
  // All three runs returned the same fabricated recipient GSTIN. Agreement
  // cannot catch this and no arithmetic involves it. Grounding is the only
  // signal that fires.
  await openInvoice(page, "07-scan-clean-inter-state");
  await expect(page.locator('[data-testid="ungrounded-recipientGstin"]')).toBeVisible();
  await expect(page.locator('[data-testid="disagreed-recipientGstin"]')).toHaveCount(0);
});

test("catches a GSTIN whose check digit does not hold", async ({ page }) => {
  await openInvoice(page, "09-scan-bad-gstin-checkdigit");
  await expect(page.locator('[data-testid="finding-SUPPLIER_GSTIN_INVALID"]')).toBeVisible();
});

test("catches an intra-state supply charged as IGST", async ({ page }) => {
  await openInvoice(page, "08-scan-wrong-tax-head");
  await expect(page.locator('[data-testid="finding-WRONG_TAX_HEAD"]')).toBeVisible();
});

test("rejects a document with no invoice number instead of queueing it", async ({ page }) => {
  await openInvoice(page, "10-scan-no-invoice-number");
  await expect(page.locator('[data-testid="status-rejected"]')).toBeVisible();
  await expect(page.locator('[data-testid="reasons"]')).toContainText("Rule 46");
  // Nothing to review on a document that is not an invoice.
  await expect(page.locator('[data-testid="save-review"]')).toHaveCount(0);
});

test("shows the source PDF beside the fields", async ({ page }) => {
  await openInvoice(page, "01-clean-intra-state");
  const source = await page.locator('[data-testid="pdf-panel"] object').getAttribute("data");
  expect(source).toMatch(/\/api\/invoices\/[0-9a-f-]+\/pdf$/);

  const response = await page.request.get(source as string);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("application/pdf");
});

test("records a review and turns every field into a label", async ({ page }) => {
  await openInvoice(page, "04-invoice-number-too-long");

  await page.locator('[data-testid="input-invoiceNumber"]').fill("HEW/26-27/891");
  await page.locator('[data-testid="save-review"]').click();
  await expect(page.locator('[data-testid="save-confirmation"]')).toBeVisible();

  await page.goto("/");
  await expect(
    page.locator('[data-testid="row-04-invoice-number-too-long.pdf"]'),
  ).toContainText("HEW/26-27/891");
  await expect(
    page
      .locator('[data-testid="row-04-invoice-number-too-long.pdf"]')
      .locator('[data-testid="status-reviewed"]'),
  ).toBeVisible();
});

test("rejects the same invoice uploaded twice", async ({ page }) => {
  // Rule 46(b) makes supplier plus number plus financial year unique, so the
  // second upload cannot be a different invoice.
  await upload(page, ["01-clean-intra-state"]);

  const rows = page.locator('[data-testid="row-01-clean-intra-state.pdf"]');
  await expect(rows).toHaveCount(2);
  await expect(rows.locator('[data-testid="status-rejected"]')).toHaveCount(1);
  await expect(rows.locator('[data-testid="status-auto_approved"]')).toHaveCount(1);
});
