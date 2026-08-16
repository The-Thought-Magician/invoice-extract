# Context

Domain language for the invoice extraction tool. Use these words in code, tests
and conversation; do not invent synonyms.

## What this is

A tool that reads Indian GST tax invoice PDFs, extracts the header fields, and
stores them so a person can see the numbers without opening the PDF. It exists
to remove manual data entry from a downstream process.

## Glossary

**Extraction** — the set of field values read off one invoice PDF by one run of
the pipeline. Not yet trusted.

**Field** — one extracted value plus the evidence for trusting it: whether it
was found in the OCR text layer (`grounded`), and what each independent
extraction run returned (`samples`). A field is never a bare string.

**Grounded** — the extracted value appears verbatim in the OCR text layer of the
source document. An ungrounded value is a fabrication candidate regardless of
how plausible it looks.

**Sample agreement** — whether independent extraction runs returned the same
value for a field. Disagreement is the signal; agreement is weak evidence, not
proof.

**Finding** — one deterministic rule that this extraction violates. Findings
carry a severity.

- **FATAL** — a particular required by CGST Rule 46 is absent, so the document
  is not a tax invoice. There is nothing to review; the document is rejected.
- **ERROR** — the document is an invoice but a checkable fact does not hold.
  Goes to a human.
- **WARNING** — a heuristic fired. Recorded, does not by itself force review.

**Route** — what happens to an extraction: `AUTO_APPROVE`, `REVIEW`, `REJECT`.

**Cold start** — the mode in which every invoice goes to review because the
per-field error rate has not yet been measured. The default. It ends when there
is a labelled set to fit a gate against.

**Audit sample** — a random slice of otherwise auto-approvable invoices sent to
review anyway, so the gate's false-negative rate keeps being measured instead of
assumed.

**Tax head** — CGST plus SGST for an intra-state supply, IGST for an
inter-state supply. Determined by comparing the supplier's state code against
the place of supply, never by reading a label off the page.

**Intra-state supply** — supplier state code equals place of supply state code.

## Deliberate non-vocabulary

**Confidence score** — not used. Verbalized LLM confidence is not a probability
and is not an input to any decision here. See ADR 0001.

**Line item** — out of scope for v1. See ADR 0003.

**IRN / signed QR** — out of scope. See ADR 0005.
