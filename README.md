# invoice-extract

Reads the header fields off Indian GST tax invoices so a person does not have to
open each PDF and type numbers into something else.

    npm install
    npm test                                            # unit suites
    npm run --workspace @invoice-extract/web build
    npm run --workspace @invoice-extract/web test:e2e

The app runs with no database server and no API key: `db/schema.sql` is applied
to an embedded Postgres, and extraction falls back to recorded answers. Set
`DATABASE_URL` and `GEMINI_API_KEY` for the real thing. See `.env.example`.

System dependencies for the OCR path: `poppler-utils` (`pdftotext`, `pdftoppm`)
and `tesseract-ocr`.

## What it does

Upload returns immediately. A background worker reads each PDF three times with
Gemini, produces a text layer (embedded for a digital PDF, Tesseract for a
scan), then decides whether a human needs to look.

That decision reads no model confidence score. It reads three things that can be
checked:

- **Deterministic rules.** CGST Rule 46 particulars, the GSTIN mod-36 check
  digit, the invoice number format, the arithmetic chain, tax head against place
  of supply, HSN shape.
- **Grounding.** The extracted value must appear on the page.
- **Agreement.** Independent runs must not disagree.

Each catches something the others cannot. A wrong total the document itself
prints grounds fine, and only arithmetic catches it. A fabricated GSTIN that all
three runs agree on is invisible to agreement and involved in no arithmetic, and
only grounding catches it. A misread digit shows up as disagreement.

## Layout

    packages/core        model, GSTIN, money, validation, routing, pipeline
    packages/adapters    Gemini, Tesseract, recorded replay
    apps/web             Next.js app, worker, API routes, review screen
    db/schema.sql        Postgres schema
    fixtures/            ten generated invoices with known ground truth
    docs/spec.md         scope and open decisions
    docs/adr/            why things are the way they are

Read `CONTEXT.md` first for the vocabulary.

## Fixtures

`fixtures/generate.py` builds ten Indian GST invoices, five digital and five
rendered to image so they have no text layer. Each plants a specific condition:
clean intra-state, clean inter-state, a 5 percent slab, an invoice number over
the Rule 46(b) limit, a total that does not add up, a wrong tax head, a GSTIN
with a bad check digit, and a document with no invoice number at all.

    python3 fixtures/generate.py && node fixtures/record-runs.mjs

They are generated rather than collected because the build environment blocks
both the Gemini API and arbitrary PDF downloads. Generating them turned out to
be better test material anyway: ground truth is exact, and the failure modes the
validation layer exists to catch are planted deliberately rather than hoped for.

## Status

Built and tested: validation, routing, pipeline, the Gemini adapter, the OCR
text layer, upload, worker, review screen, duplicate detection, the schema.

Not built: authentication, object storage, a scheduled worker process, line
items (v2), and the threshold-fitting script that would let `COLD_START` be
turned off.
