# invoice-extract

Deterministic validation and review routing for Indian GST tax invoices.

This repository currently contains the part of the pipeline that is fully
determined by law and arithmetic: the validation rule set and the routing
decision. Ingest, OCR and extraction are not built, because the decisions they
depend on are still open (see `docs/spec.md`).

    pip install -e .
    python -m pytest
    python -m mypy src tests

Read `CONTEXT.md` for the domain language, `docs/spec.md` for scope and open
decisions, `docs/adr/` for why things are the way they are.

## Tested seams

- `invoice_extract.gstin` — is this a well-formed GSTIN, and what does it embed
- `invoice_extract.validation.validate` — which deterministic rules does this
  extraction violate
- `invoice_extract.routing.decide` — auto-approve, review, or reject
