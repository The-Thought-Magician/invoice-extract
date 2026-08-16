-- Postgres schema for invoice-extract.
--
-- Two things drive the shape here. First, every routing decision must be
-- explainable after the fact, so findings and reasons are stored, not just the
-- outcome. Second, every human correction is a labelled example, because that
-- is the only source of ground truth this system has (ADR 0002, ADR 0005).

create type invoice_status as enum (
  'queued',       -- accepted, not yet processed
  'processing',
  'auto_approved',
  'awaiting_review',
  'reviewed',
  'rejected',     -- fatal finding: not a tax invoice under Rule 46
  'failed'        -- the pipeline itself errored
);

create type route as enum ('auto_approve', 'review', 'reject');
create type severity as enum ('fatal', 'error', 'warning');
create type grounded as enum ('true', 'false', 'not_attempted');

-- Vendor identity is the GSTIN, never the printed name (ADR 0004).
--
-- Deliberately not a foreign key target for invoice.supplier_gstin. Vendors are
-- discovered from invoices rather than registered in advance, so the first
-- invoice from an unknown supplier has to succeed. The invoice's own GSTIN is
-- authoritative; this table is a display-name lookup, joined when a row exists.
create table vendor (
  gstin           char(15) primary key,
  display_name    text,
  state_code      char(2) not null generated always as (substring(gstin from 1 for 2)) stored,
  pan             char(10) not null generated always as (substring(gstin from 3 for 10)) stored,
  created_at      timestamptz not null default now()
);

create table invoice (
  id              uuid primary key default gen_random_uuid(),
  storage_key     text not null,             -- where the PDF lives
  original_name   text not null,
  uploaded_by     text not null,
  uploaded_at     timestamptz not null default now(),
  status          invoice_status not null default 'queued',
  processed_at    timestamptz,

  -- Whether the document arrived with a usable text layer or had to be OCR'd.
  -- Roughly half this corpus is scans, and that half behaves differently.
  had_text_layer  boolean,
  text_layer      text,

  -- Header fields. Values are the merged modal answer across runs; the raw
  -- per-run answers live in extraction_run.
  supplier_gstin              char(15),
  recipient_gstin             char(15),
  -- Deliberately wider than the sixteen characters Rule 46(b) allows. An
  -- over-long invoice number is a finding to show a reviewer, not a value to
  -- refuse to store. A storage constraint here turns a flaggable invoice into
  -- a failed one, which hides exactly the violation the tool exists to surface.
  invoice_number              text,
  invoice_date                date,
  place_of_supply_state_code  char(2),
  taxable_value_paise         bigint,        -- integer paise, never float
  cgst_amount_paise           bigint,
  sgst_amount_paise           bigint,
  igst_amount_paise           bigint,
  cess_amount_paise           bigint,
  total_value_paise           bigint,
  hsn                         text,          -- malformed HSN is a finding, not a write failure

  -- Per-field evidence, keyed by field name:
  --   { "totalValue": { "grounded": "true", "samples": ["1180.00", ...] } }
  field_evidence  jsonb not null default '{}'::jsonb,

  route           route,
  route_reasons   text[] not null default '{}',

  -- Rule 46(b) makes (supplier, number, financial year) genuinely unique.
  duplicate_key   text
);

-- Two invoices from the same supplier with the same number in the same
-- financial year cannot both be real. Enforced, not merely detected.
create unique index invoice_duplicate_key_uniq
  on invoice (duplicate_key)
  where duplicate_key is not null and status <> 'rejected';

create index invoice_awaiting_review_idx
  on invoice (uploaded_at)
  where status = 'awaiting_review';

create index invoice_supplier_idx on invoice (supplier_gstin, invoice_date desc);

-- One row per independent model run, kept so a disagreement can be inspected
-- and so a prompt or model change can be evaluated against past documents.
create table extraction_run (
  id            uuid primary key default gen_random_uuid(),
  invoice_id    uuid not null references invoice (id) on delete cascade,
  run_index     smallint not null,
  model         text not null,
  prompt_hash   text not null,
  raw_output    jsonb not null,
  created_at    timestamptz not null default now(),
  unique (invoice_id, run_index)
);

-- Every deterministic rule the extraction violated. Stored so a decision made
-- months ago can still be explained.
create table finding (
  id            bigserial primary key,
  invoice_id    uuid not null references invoice (id) on delete cascade,
  code          text not null,
  severity      severity not null,
  field_name    text not null,
  message       text not null
);

create index finding_invoice_idx on finding (invoice_id);
create index finding_code_idx on finding (code);

-- The labelled set. This table is the reason the gate can ever be opened.
create table correction (
  id                bigserial primary key,
  invoice_id        uuid not null references invoice (id) on delete cascade,
  field_name        text not null,
  extracted_value   text,          -- what the pipeline produced
  corrected_value   text,          -- what the human says is right
  was_correct       boolean not null,  -- true when the reviewer confirmed as-is
  reviewer          text not null,
  reviewed_at       timestamptz not null default now(),
  -- Which model and prompt produced the value being judged. Thresholds must be
  -- refit whenever either changes, so a correction is only evidence about the
  -- configuration that produced it.
  model             text not null,
  prompt_hash       text not null
);

create index correction_field_idx on correction (field_name, model, prompt_hash);

-- Random slice of auto-approved invoices routed to a human anyway, so the
-- gate's false-negative rate is measured rather than assumed.
create table audit_sample (
  invoice_id    uuid primary key references invoice (id) on delete cascade,
  selected_at   timestamptz not null default now(),
  resolved_at   timestamptz,
  found_error   boolean
);
