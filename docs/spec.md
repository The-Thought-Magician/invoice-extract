# Invoice extraction — v1 spec

Derived from a grilling session. Every decision below has a recorded reason;
where a decision is still open it is marked OPEN and must be settled before the
stage that depends on it is built.

## Purpose

Remove manual data entry. A person uploads invoice PDFs, comes back later, and
reads the header fields from a table instead of opening each PDF and typing
numbers into a downstream process.

## Scope

**In scope, v1:** header fields of Indian GST tax invoices, asynchronous
processing, deterministic validation, review routing, a review queue.

**Out of scope, v1:** line items (v2), e-invoice QR verification (no supplier
coverage), IRN cancellation checks, purchase-order matching, payment.

## Volume

5 to 10 invoices per day initially, target 500 to 1000 per day. Upload returns
immediately; processing is a background job; the user returns for results.

## Field set

| Field | Source of truth for validation |
| --- | --- |
| `supplier_gstin` | Rule 46(a), mod-36 check digit |
| `recipient_gstin` | Rule 46(d), mod-36 check digit, optional if unregistered |
| `invoice_number` | Rule 46(b), max 16 chars, `[A-Za-z0-9/-]` |
| `invoice_date` | Rule 46(c), normalised to ISO 8601 upstream |
| `place_of_supply_state_code` | Rule 46(n), drives the tax head |
| `taxable_value` | Rule 46(k) |
| `cgst_amount`, `sgst_amount`, `igst_amount`, `cess_amount` | Rule 46(m) |
| `total_value` | Rule 46(j) |
| `hsn` | Rule 46(g), 4, 6 or 8 digits |

Vendor **name** is not extracted as an identity. GSTIN is the vendor key; the
name is resolved from a vendor table for display. See ADR 0004.

## Pipeline

1. **Ingest.** Store the PDF, create a job, return an ID. Never block the user.
2. **Text layer.** Read the embedded text layer. If absent or sparse, OCR the
   rasterised pages. OPEN: what fraction of incoming invoices are scans rather
   than digital PDFs. This single number decides whether OCR is trivial or is
   the hardest part of the system.
3. **Gate.** Reject anything that is not an invoice: no invoice number, no
   date, no supplier GSTIN, no total. Cheap, deterministic, runs before any
   model call.
4. **Extract.** Three independent Gemini runs against the PDF, each returning
   the field set as structured output. Per-field agreement across the three
   runs is recorded on the field.
5. **Ground.** For every extracted value, assert it appears verbatim in the
   text layer. Ungrounded values are fabrication candidates.
6. **Validate.** Run the deterministic rule set (`validation.py`).
7. **Route.** `REJECT` on any FATAL finding. Otherwise `REVIEW` if cold start,
   audit-sampled, any ERROR finding, any ungrounded field, or any field where
   the runs disagreed. Otherwise `AUTO_APPROVE`.
8. **Store.** One row per invoice, plus the full finding list and the routing
   reasons, so any decision can be explained after the fact.
9. **Review.** A human sees the PDF beside the extracted fields, with the
   failing checks named. Every correction is written to a corrections table.

## Duplicate detection

Natural key: `(supplier_gstin, invoice_number, financial_year)`. Rule 46(b)
guarantees uniqueness of the invoice number within a financial year per
supplier, so this is a real key, not a heuristic. The Indian financial year runs
April to March.

## Review capacity

Target 50 of 1000 per day, roughly 5 percent. This is a capacity budget, not a
measured error rate. It becomes achievable only if the measured error rate
supports it. Do not set the auto-approve gate before the measurement exists.

## Cold start, and how the gate gets set

There is no labelled ground truth and no e-invoice QR to supply one for free.
Therefore:

1. Ship with `cold_start=True`. Every invoice goes to review. At 5 to 10 a day
   this costs almost nothing.
2. Every human correction is a label. After roughly 200 reviewed invoices there
   is a per-field error rate.
3. Fit the auto-approve gate per field against that set, against a cost
   function, not against F1 and not against a round number.
4. Keep an audit sample of auto-approved invoices flowing to review forever, so
   the false-negative rate is measured rather than assumed.
5. Refit whenever the model or prompt changes.

## Open decisions

- **OPEN** Fraction of invoices that are scans rather than digital-text PDFs.
- **OPEN** OCR engine.
- **OPEN** Datastore and application stack.
- **OPEN** Evidence behind the estimated 3 to 5 percent error rate. Treated as
  unknown until measured.
- **OPEN** What happens to already-stored rows when the model or prompt changes.

## Settled since first draft

- **Scan ratio:** roughly 1:1 scans to digital-text PDFs. OCR is therefore
  first-class, and grounding is only as reliable as OCR on half the volume.
- **Stack:** TypeScript backend, Next.js frontend, Postgres. ADR 0006.
- **OCR:** Gemini extracts, Tesseract produces the text layer for grounding.
- **Error rate:** taken as 3 to 5 percent by direction. The `coldStart` switch
  remains in the code so the assumption can be replaced with a measurement
  without a rewrite, and the audit sample keeps measuring what the gate lets
  through either way.
- **UI reference:** beautifului.dev, copy-paste components aimed at
  human-in-the-loop approval flows. Components are dropped into the Next.js app
  rather than installed, so the review screen is built on Tailwind primitives
  they compose with.

## Measuring against the real model

`npm run live` runs the ten fixtures through Gemini for real and reports
per-field accuracy against known ground truth, split digital versus scanned.

Read the two splits separately. They are different problems. The digital half
tests whether the model reads a clean text-bearing PDF. The scanned half tests
grounding against OCR output, and only that half is expected to generate review
traffic from noise rather than from genuine error.

What the run cannot tell you is whether the auto-approve gate is safe. Ten
documents cannot support a threshold. That measurement comes from the
`correction` table once a few hundred of your own invoices have been reviewed.
