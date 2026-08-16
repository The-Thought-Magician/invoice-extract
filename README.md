# invoice-extract

[![ci](https://github.com/The-Thought-Magician/invoice-extract/actions/workflows/ci.yml/badge.svg)](https://github.com/The-Thought-Magician/invoice-extract/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

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

`fixtures/pdfs/` holds ten Indian GST invoices, five digital and five rendered
to image so they have no text layer. Each plants a specific condition: clean
intra-state, clean inter-state, a 5 percent slab, an invoice number over the
Rule 46(b) limit, a total that does not add up, a wrong tax head, a GSTIN with a
bad check digit, and a document with no invoice number at all. Ground truth for
every one is in `fixtures/expected.json`.

    node fixtures/record-runs.mjs   # refresh the recorded model answers

They were generated rather than collected, which turned out to be better test
material: ground truth is exact, and the failure modes the validation layer
exists to catch are planted deliberately rather than hoped for.

## Running it against the real model

    GEMINI_API_KEY=... npm run live

Puts all ten fixtures through the real pipeline: real OCR, three real Gemini
runs each, real validation and routing. Prints per-field accuracy against known
ground truth, split by digital versus scanned, and writes
`fixtures/live-report.json`.

The runner itself was verified end to end against a local stand-in for the API,
so the only unproven part when you supply a key is Gemini's own reading:

    npm run live:stub &
    GEMINI_API_KEY=stub GEMINI_ENDPOINT=http://127.0.0.1:3199/v1beta npm run live

Ten documents is a smoke test, not the measurement that opens the auto-approve
gate. That one comes from the `correction` table, on your own invoices, at a few
hundred documents. See ADR 0002.

## Status

Built and tested: validation, routing, pipeline, the Gemini adapter, the OCR
text layer, upload, worker, review screen, duplicate detection, the schema.

Not built: authentication, object storage, a scheduled worker process, line
items (v2), and the threshold-fitting script that would let `COLD_START` be
turned off.

## Background

- `CLAUDE.md`: start here if you are an agent or new to the repo
- `CONTEXT.md`: the domain vocabulary
- `docs/DECISION-LOG.md`: every design question asked, answered, and its consequence
- `docs/RESEARCH.md`: the evidence behind the decisions, with sources
- `docs/adr/`: six architecture decision records
- `docs/spec.md`: scope and what is still open

## License

MIT. See [LICENSE](LICENSE).
