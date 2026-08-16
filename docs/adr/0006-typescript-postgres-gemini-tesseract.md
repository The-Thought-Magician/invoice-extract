# 0006: TypeScript, Postgres, Gemini for extraction, Tesseract for grounding

## Status
Accepted

## Context
Half the incoming invoices are scans with no text layer. Grounding, one of the
three signals that replaced model confidence, works by checking the extracted
value appears in the text layer. On a scan that layer must be produced by OCR.

The review screen is a real product surface, not an afterthought.

## Decision
- **TypeScript** for the backend, **Next.js** for the frontend. The validation
  core, first written in Python, has been ported; the Python implementation is
  retained on `feat/validation-core` as a reference but is not the source of
  truth.
- **Postgres.** The duplicate key is enforced with a unique index rather than
  merely detected, the review queue is a partial index, and background workers
  will run concurrently.
- **Gemini reads, Tesseract grounds.** Gemini extracts fields directly from the
  document image, which is what it is good at. Tesseract exists only to produce
  a text layer for the grounding check.

## Consequences
OCR errors weaken grounding without corrupting extraction. That asymmetry is
the point: a Tesseract misread makes a correct Gemini value look ungrounded and
sends it to review, which is a false positive costing reviewer time. It never
lets a wrong value through, which would be the expensive failure.

The review queue on the scanned half will therefore be larger than on the
digital half. Measure the two separately from day one. If the scan-side false
positive rate is intolerable, the escalation is a purpose-built invoice parser
with per-field confidence and bounding boxes, not a better Tesseract config.

Money is stored and compared as integer paise. Floating point is never used for
an amount.
