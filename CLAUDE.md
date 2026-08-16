# Working on this repository

Read this first, then `CONTEXT.md` for the vocabulary. Everything here was
settled deliberately; the reasoning is in `docs/`.

## What this is

A tool that reads header fields off Indian GST tax invoices so a person does not
have to open each PDF and retype numbers into a downstream process. Built for a
supplier base **below the ₹5 crore e-invoicing threshold**, so no invoice
carries a signed QR code and there is no free ground truth.

## Run it

    npm install
    npm test                                              # 125 unit tests
    npm run --workspace @invoice-extract/web build
    npm run --workspace @invoice-extract/web test:e2e     # 21 Playwright tests
    GEMINI_API_KEY=... npm run live                       # real model, 10 fixtures

Never run `next dev` and `next build` against the same tree. They share
`.next`, and the dev server wedges permanently once its chunks are deleted
underneath it: the first request compiles, every later one dies in the router
before reaching route code, so the log goes silent while the port stays open.
It looks exactly like a hang in application code and is not. `rm -rf
apps/web/.next` and start one server.

System dependencies: `poppler-utils` and `tesseract-ocr`. No database server
needed; without `DATABASE_URL` the app runs on PGlite, an embedded Postgres.

## The one idea everything hangs off

**No decision in this system reads a model's self-reported confidence.** The
original design auto-approved above 90 percent. That was discarded on evidence:
verbalized confidence is quantized onto a handful of round numbers, so
thresholding it thresholds nothing, and Gemini's logprobs are disabled on the
3.X generation. See `docs/adr/0001` and `docs/RESEARCH.md`.

Three checkable signals replaced it, and each catches something the others
cannot:

| Signal | Catches | Blind to |
| --- | --- | --- |
| Deterministic rules | arithmetic, Rule 46, GSTIN check digit, tax head | a plausible wrong string |
| Grounding | fabricated values not on the page | a wrong value the document itself prints |
| Run agreement | unstable reads, misread digits | a value the model gets confidently wrong every time |

If you are tempted to add a fourth signal, check it is not a fourth way of
asking the model to grade itself.

## Do not re-litigate these

Each was argued and recorded. Reopening needs new evidence, not a fresh opinion.

- **Cold start defaults to reviewing everything** (`docs/adr/0002`). There is no
  labelled ground truth. The gate opens when the `correction` table supports it,
  not before.
- **Header fields only in v1** (`docs/adr/0003`). Line items are v2 and are most
  of the remaining work.
- **GSTIN is the vendor key; the printed name is display only** (`docs/adr/0004`).
- **No e-invoice QR path** (`docs/adr/0005`). Coverage is effectively zero for
  this supplier base. Revisit only if the supplier mix changes or the threshold
  is lowered by notification.
- **TypeScript, Postgres, Gemini reads, Tesseract grounds** (`docs/adr/0006`).
- **Money is integer paise everywhere.** No float ever touches an amount.

## Landmines already hit

Do not reintroduce these. Each cost a debugging cycle and each has a test now.

- **No foreign key from `invoice.supplier_gstin` to `vendor`.** Vendors are
  discovered from invoices, not registered in advance. The FK made every
  first-time supplier fail.
- **Every extracted header field is `text`, none are length-constrained.** Rule
  46(b) caps an invoice number at sixteen characters, but an over-long one is a
  *finding to show a reviewer*, not a write to refuse. The constraint turned a
  flaggable invoice into a failed one and hid the violation. This was fixed for
  `invoice_number` and then found again on `supplier_gstin`, `recipient_gstin`
  and `place_of_supply_state_code`. The GSTIN case is the sharpest: the mod-36
  check digit exists to catch a one-character OCR slip, and that slip often
  changes the length too, so `char(15)` fired on exactly the input the check
  was for. If you are adding a column for something read off a document, it is
  `text`. The rule set does the judging, not the schema.
- **`invoice_date` is a real `date`, so it is written only when it parses.**
  Invoices print DD/MM/YYYY; handing that to Postgres raises 22008 and kills
  the invoice. An unparseable date is an Error finding, so the column takes
  null and the finding does the talking. The raw string survives in
  `field_evidence` and `extraction_run.raw_output`. See `columnValue`.
- **Multi-statement writes are transactional.** `recordReview` and `saveResult`
  each write several tables. Half-applying `recordReview` is the expensive one:
  it leaves the `correction` table asserting a change that never landed, and a
  retry inserts every label twice. That table is the only route to opening the
  gate, so corrupting it is worse than failing the write.
- **On PGlite, use its own `transaction()`, never bare `begin`/`commit`.** There
  is one backend. Two concurrent callers issuing their own begin/commit
  interleave on it: one commits the other's half-written rows, and a violation
  in either leaves the session aborted so everything after fails with 25P02.
- **Grounding is field-aware.** The extractor normalises dates to ISO; invoices
  print DD/MM/YYYY. Literal comparison marked every invoice ungrounded, which
  destroys the signal by firing on all of them. See `isFieldGrounded`.
- **`date` columns come back as JS `Date`, not strings**, from both PGlite and
  node-postgres. Assuming a string crashes the render. And format them with
  `isoDate`, never `toISOString`: the driver builds a `date` at *local*
  midnight, so east of UTC `toISOString().slice(0, 10)` reports the previous
  day. On the review screen that shifted value seeds the form, so a reviewer
  confirming an unchanged field writes the wrong date back as a label.
- **Nothing external may run unbounded.** `pdftotext`, `pdftoppm`, `tesseract`
  and the Gemini fetch all carry timeouts. Without one a single pathological
  PDF hangs the drain forever and the invoice stays claimed as `processing`
  with nothing to release it. `maxDuration` in a route is a deployment hint and
  does nothing locally.
- **A claim can outlive its worker.** `claimNextQueued` stamps `claimed_at`;
  `releaseStranded` returns anything claimed too long ago. A worker killed
  mid-extraction otherwise leaves the invoice invisible to both the queue and
  the review list.
- **OCR resolution is not monotonic.** Tesseract reads a GSTIN correctly at 300
  dpi and wrong at 200; it reads an invoice number correctly at 200 and wrong at
  300. Both directions are pinned by tests. Do not "optimise" the dpi without
  measuring.

## Environment constraints in the Anthropic sandbox

If you are an agent working on this in the same cloud environment:

- `generativelanguage.googleapis.com` and `aiplatform.googleapis.com` return
  **403 at the org proxy**. `*.googleapis.com` is allowlisted for Drive paths
  only. Gemini cannot be called. Do not look for a tunnel around this; it is a
  deliberate network policy. `scripts/stub-gemini.mjs` exists so the pipeline
  can still be exercised end to end.
- Arbitrary PDF downloads are blocked, which is why `fixtures/pdfs/` were
  generated rather than collected.
- Chromium is preinstalled at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`.
  Set `CHROMIUM_PATH` to it; do not run `playwright install`.
- `git clone` over HTTPS works. The GitHub API and codeload do not.

## Where the work is

`docs/spec.md` has scope and the open decisions. The short version of what is
not built:

- Authentication, object storage, a scheduled worker process.
- Line items (v2), which changes the schema, the review screen and the
  validation set.
- The threshold-fitting script that reads the `correction` table and produces
  per-field gates, which is what lets `COLD_START` be turned off.
- Reprocessing policy: what happens to stored rows when the model or prompt
  changes. `prompt_hash` is recorded against every correction so this is
  answerable, but nothing acts on it yet.

## House style

Comments explain **why**, never what. Tests are named as behaviour and their
expected values come from an independent source: the CGST Rules, arithmetic done
by hand, or a string read off a fixture. Never from re-running the
implementation.
