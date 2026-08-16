/**
 * Everything that reads or writes an invoice.
 *
 * Amounts cross this boundary as integer paise. A rupee string only exists at
 * the two edges: what the document printed, and what a person reads.
 */

import {
  type Finding,
  type InvoiceExtraction,
  type Decision,
  FIELD_NAMES,
  type FieldName,
  Route,
  Severity,
  duplicateKey,
  parsePaise,
} from "@invoice-extract/core";

import { getDatabase, type Queryable } from "./db";

export const INVOICE_STATUSES = [
  "queued",
  "processing",
  "auto_approved",
  "awaiting_review",
  "reviewed",
  "rejected",
  "failed",
] as const;

export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/**
 * Narrow a query-string value to a status.
 *
 * The enum is enforced by Postgres, so an unrecognised value is a 22P02 rather
 * than an empty result. Rejecting it here turns `?status=nonsense` into a 400
 * instead of an unhandled 500.
 */
export function asInvoiceStatus(value: string | null): InvoiceStatus | null {
  return INVOICE_STATUSES.includes(value as InvoiceStatus) ? (value as InvoiceStatus) : null;
}

export interface InvoiceRow {
  id: string;
  original_name: string;
  status: InvoiceStatus;
  // timestamptz, like date, arrives as a JS Date from both drivers.
  uploaded_at: Date | string;
  supplier_gstin: string | null;
  invoice_number: string | null;
  // Both drivers return a `date` column as a JS Date, not a string.
  invoice_date: Date | string | null;
  total_value_paise: string | null;
  route: string | null;
  route_reasons: string[];
  had_text_layer: boolean | null;
}

export interface InvoiceDetail extends InvoiceRow {
  recipient_gstin: string | null;
  place_of_supply_state_code: string | null;
  taxable_value_paise: string | null;
  cgst_amount_paise: string | null;
  sgst_amount_paise: string | null;
  igst_amount_paise: string | null;
  cess_amount_paise: string | null;
  hsn: string | null;
  field_evidence: Record<string, { grounded: string; samples: string[] }>;
  text_layer: string | null;
  findings: Array<{ code: string; severity: string; field_name: string; message: string }>;
}

const AMOUNT_COLUMNS: Partial<Record<FieldName, string>> = {
  taxableValue: "taxable_value_paise",
  cgstAmount: "cgst_amount_paise",
  sgstAmount: "sgst_amount_paise",
  igstAmount: "igst_amount_paise",
  cessAmount: "cess_amount_paise",
  totalValue: "total_value_paise",
};

const TEXT_COLUMNS: Partial<Record<FieldName, string>> = {
  supplierGstin: "supplier_gstin",
  recipientGstin: "recipient_gstin",
  invoiceNumber: "invoice_number",
  invoiceDate: "invoice_date",
  placeOfSupplyStateCode: "place_of_supply_state_code",
  hsn: "hsn",
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * What to actually put in the column for a text-ish field.
 *
 * Every one of these columns is `text` and takes the extracted string verbatim
 * except `invoice_date`, which is a real `date`. Postgres rejects anything
 * that is not a date, so handing it "31/03/2024" throws 22008 and the invoice
 * dies as 'failed'. That is the wrong outcome: an unparseable date is already
 * an Error-severity finding, which means "show a human", not "refuse the row".
 *
 * So the column gets null and the finding does the talking. The raw string is
 * not lost: it stays in field_evidence and in extraction_run.raw_output.
 */
function columnValue(name: FieldName, value: string | null): string | null {
  if (name !== "invoiceDate") return value;
  return value !== null && ISO_DATE.test(value) ? value : null;
}

export async function createInvoice(input: {
  storageKey: string;
  originalName: string;
  uploadedBy: string;
}): Promise<string> {
  const database = await getDatabase();
  const { rows } = await database.query<{ id: string }>(
    `insert into invoice (storage_key, original_name, uploaded_by)
     values ($1, $2, $3) returning id`,
    [input.storageKey, input.originalName, input.uploadedBy],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("insert returned no id");
  return id;
}

export async function claimNextQueued(): Promise<{ id: string; storage_key: string } | null> {
  const database = await getDatabase();
  // `for update skip locked` is what makes more than one worker safe. Without
  // it two workers process the same invoice and bill Gemini twice for it.
  const { rows } = await database.query<{ id: string; storage_key: string }>(
    `update invoice set status = 'processing', claimed_at = now()
     where id = (
       select id from invoice where status = 'queued'
       order by uploaded_at limit 1 for update skip locked
     )
     returning id, storage_key`,
  );
  return rows[0] ?? null;
}

/**
 * Return invoices stranded in 'processing' to the queue.
 *
 * A worker that dies mid-extraction (an OOM, a container restart, a Gemini
 * call that never returns) leaves its claim set forever. The invoice is then
 * invisible to the queue and to the review list both, so it is simply lost.
 * Anything claimed longer ago than one run could plausibly take is assumed
 * dead. Safe to run repeatedly: a live worker's row is younger than the cutoff.
 */
export async function releaseStranded(olderThanMinutes = 30): Promise<number> {
  const database = await getDatabase();
  const { rows } = await database.query<{ id: string }>(
    `update invoice set status = 'queued', claimed_at = null
     where status = 'processing'
       and claimed_at < now() - ($1 || ' minutes')::interval
     returning id`,
    [String(olderThanMinutes)],
  );
  return rows.length;
}

export async function saveResult(input: {
  id: string;
  extraction: InvoiceExtraction;
  findings: readonly Finding[];
  decision: Decision;
  textLayer: string;
  hadTextLayer: boolean;
  model: string;
  promptHash: string;
  rawRuns: readonly unknown[];
}): Promise<{ status: InvoiceStatus; duplicateOf: string | null }> {
  const database = await getDatabase();
  const { extraction, decision } = input;

  const status: InvoiceStatus =
    decision.route === Route.Reject
      ? "rejected"
      : decision.route === Route.AutoApprove
        ? "auto_approved"
        : "awaiting_review";

  const evidence = Object.fromEntries(
    FIELD_NAMES.map((name) => [
      name,
      { grounded: String(extraction[name].grounded), samples: extraction[name].samples },
    ]),
  );

  const key = computeDuplicateKey(extraction);

  const values: unknown[] = [
    input.id,
    status,
    input.hadTextLayer,
    input.textLayer,
    JSON.stringify(evidence),
    decision.route,
    decision.reasons,
    key,
    ...Object.keys(TEXT_COLUMNS).map((name) =>
      columnValue(name as FieldName, extraction[name as FieldName].value),
    ),
    ...Object.keys(AMOUNT_COLUMNS).map((name) => {
      const paise = parsePaise(extraction[name as FieldName].value);
      return paise === null ? null : paise.toString();
    }),
  ];

  const textAssignments = Object.values(TEXT_COLUMNS).map(
    (column, index) => `${column} = $${9 + index}`,
  );
  const amountOffset = 9 + Object.keys(TEXT_COLUMNS).length;
  const amountAssignments = Object.values(AMOUNT_COLUMNS).map(
    (column, index) => `${column} = $${amountOffset + index}`,
  );

  // One transaction for the whole result. The invoice row, its findings and its
  // raw runs are a single explanation of one decision; committing some of them
  // leaves a routed invoice whose reasons belong to a previous run, which is
  // exactly the after-the-fact explainability the schema exists to guarantee.
  return database.transaction(async (tx) => {
    let duplicateOf: string | null = null;
    let finalStatus = status;

    await tx.query("savepoint before_invoice_write");
    try {
      await tx.query(
        `update invoice set
           status = $2, processed_at = now(), had_text_layer = $3, text_layer = $4,
           field_evidence = $5::jsonb, route = $6, route_reasons = $7, duplicate_key = $8,
           ${[...textAssignments, ...amountAssignments].join(", ")}
         where id = $1`,
        values,
      );
    } catch (error) {
      // The unique index on duplicate_key is the duplicate check. Catching the
      // violation rather than pre-querying means two workers racing on the same
      // invoice cannot both win.
      if (!isUniqueViolation(error)) throw error;

      // Postgres aborts the transaction on a constraint violation, so the
      // recovery has to start from a savepoint taken before the failing write.
      // Without one every statement after this point fails with 25P02.
      await tx.query("rollback to savepoint before_invoice_write");

      duplicateOf = key === null ? null : await findByDuplicateKey(key, input.id, tx);
      finalStatus = "rejected";
      await tx.query(
        `update invoice set status = 'rejected', processed_at = now(), route = 'reject',
           route_reasons = $2, had_text_layer = $3, text_layer = $4, field_evidence = $5::jsonb
         where id = $1`,
        [
          input.id,
          [
            `duplicate: this supplier already issued invoice ${extraction.invoiceNumber.value} in this financial year`,
          ],
          input.hadTextLayer,
          input.textLayer,
          JSON.stringify(evidence),
        ],
      );
    }

    // Findings and runs are written on every path, the duplicate one included.
    // A rejection that stored neither could not be audited or re-evaluated
    // against a later prompt, which is the whole point of extraction_run.
    await tx.query("delete from finding where invoice_id = $1", [input.id]);
    for (const finding of input.findings) {
      await tx.query(
        `insert into finding (invoice_id, code, severity, field_name, message)
         values ($1, $2, $3, $4, $5)`,
        [input.id, finding.code, severityName(finding.severity), finding.field, finding.message],
      );
    }

    await tx.query("delete from extraction_run where invoice_id = $1", [input.id]);
    for (const [index, raw] of input.rawRuns.entries()) {
      await tx.query(
        `insert into extraction_run (invoice_id, run_index, model, prompt_hash, raw_output)
         values ($1, $2, $3, $4, $5::jsonb)`,
        [input.id, index, input.model, input.promptHash, JSON.stringify(raw)],
      );
    }

    return { status: finalStatus, duplicateOf };
  });
}

export function computeDuplicateKey(extraction: InvoiceExtraction): string | null {
  const supplier = extraction.supplierGstin.value;
  const number = extraction.invoiceNumber.value;
  const date = extraction.invoiceDate.value;
  if (!supplier || !number || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return duplicateKey(supplier, number, date);
}

/**
 * The invoice this one duplicates.
 *
 * The `status <> 'rejected'` predicate is not a filter for its own sake: it
 * matches the partial unique index, which is the only thing that makes this a
 * lookup rather than a sequential scan. It also names the right row, because a
 * previously rejected invoice is not what the live one collides with, because
 * the index excludes it from the uniqueness check in the first place.
 */
async function findByDuplicateKey(
  key: string,
  exclude: string,
  client?: Queryable,
): Promise<string | null> {
  const database = client ?? (await getDatabase());
  const { rows } = await database.query<{ id: string }>(
    `select id from invoice
     where duplicate_key = $1 and status <> 'rejected' and id <> $2
     limit 1`,
    [key, exclude],
  );
  return rows[0]?.id ?? null;
}

export async function markFailed(id: string, reason: string): Promise<void> {
  const database = await getDatabase();
  await database.query(
    "update invoice set status = 'failed', route_reasons = $2, processed_at = now() where id = $1",
    [id, [reason]],
  );
}

export async function listInvoices(status?: InvoiceStatus): Promise<InvoiceRow[]> {
  const database = await getDatabase();
  const { rows } = await database.query<InvoiceRow>(
    `select id, original_name, status, uploaded_at, supplier_gstin, invoice_number,
            invoice_date, total_value_paise, route, route_reasons, had_text_layer
     from invoice ${status ? "where status = $1" : ""}
     order by uploaded_at desc, original_name`,
    status ? [status] : [],
  );
  return rows;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a path segment can be an invoice id at all.
 *
 * `id` is a uuid column, so a segment that is not one reaches Postgres as a bad
 * literal and raises 22P02. An unknown id is a 404, not a server error, and
 * checking the shape first is what makes that distinction possible.
 */
export function isInvoiceId(value: string): boolean {
  return UUID.test(value);
}

export async function getInvoice(id: string): Promise<InvoiceDetail | null> {
  if (!isInvoiceId(id)) return null;
  const database = await getDatabase();
  const { rows } = await database.query<InvoiceDetail>("select * from invoice where id = $1", [
    id,
  ]);
  const invoice = rows[0];
  if (!invoice) return null;

  const { rows: findings } = await database.query<InvoiceDetail["findings"][number]>(
    "select code, severity, field_name, message from finding where invoice_id = $1 order by severity, id",
    [id],
  );
  return { ...invoice, findings };
}

/**
 * The prompt hash the stored values were produced under.
 *
 * A correction is only evidence about the model and prompt that produced the
 * value being judged, which is why `correction.prompt_hash` exists at all. It
 * has to be the hash from the extraction being corrected, not one invented at
 * review time; otherwise the threshold-fitting script cannot tell which
 * configuration a label belongs to and the gate can never be opened (ADR 0002).
 */
export async function promptHashFor(id: string): Promise<string | null> {
  if (!isInvoiceId(id)) return null;
  const database = await getDatabase();
  const { rows } = await database.query<{ prompt_hash: string }>(
    "select prompt_hash from extraction_run where invoice_id = $1 order by run_index limit 1",
    [id],
  );
  return rows[0]?.prompt_hash ?? null;
}

/**
 * Record a review.
 *
 * Every field the reviewer touched, and every field they confirmed as correct,
 * becomes a row in `correction`. Confirmations matter as much as corrections:
 * without them the labelled set only contains failures and the measured error
 * rate is meaningless.
 */
export async function recordReview(input: {
  id: string;
  reviewer: string;
  values: Partial<Record<FieldName, string | null>>;
  model: string;
  promptHash: string;
}): Promise<void> {
  const database = await getDatabase();
  const before = await getInvoice(input.id);
  if (!before) throw new Error(`no invoice ${input.id}`);

  const assignments: string[] = [];
  const parameters: unknown[] = [input.id];
  for (const name of FIELD_NAMES) {
    if (!(name in input.values)) continue;
    const raw = input.values[name] ?? null;
    const amountColumn = AMOUNT_COLUMNS[name];
    if (amountColumn) {
      const paise = raw === null ? null : parsePaise(raw);
      parameters.push(paise === null ? null : paise.toString());
      assignments.push(`${amountColumn} = $${parameters.length}`);
    } else {
      const textColumn = TEXT_COLUMNS[name];
      if (!textColumn) continue;
      parameters.push(columnValue(name, raw));
      assignments.push(`${textColumn} = $${parameters.length}`);
    }
  }

  // The corrections and the invoice update are one act. Committing the labels
  // without the update would leave the labelled set asserting a correction that
  // was never applied, and a retry would insert every label a second time.
  await database.transaction(async (tx) => {
    for (const name of FIELD_NAMES) {
      if (!(name in input.values)) continue;
      const corrected = input.values[name] ?? null;
      const extracted = currentValue(before, name);
      await tx.query(
        `insert into correction
           (invoice_id, field_name, extracted_value, corrected_value, was_correct,
            reviewer, model, prompt_hash)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          input.id,
          name,
          extracted,
          corrected,
          normalise(extracted) === normalise(corrected),
          input.reviewer,
          input.model,
          input.promptHash,
        ],
      );
    }

    await tx.query(
      `update invoice set status = 'reviewed'${assignments.length ? ", " + assignments.join(", ") : ""}
       where id = $1`,
      parameters,
    );

    await tx.query(
      `update audit_sample set resolved_at = now(),
         found_error = exists (
           select 1 from correction where invoice_id = $1 and was_correct = false
         )
       where invoice_id = $1`,
      [input.id],
    );
  });
}

function currentValue(invoice: InvoiceDetail, name: FieldName): string | null {
  const amountColumn = AMOUNT_COLUMNS[name];
  if (amountColumn) {
    const paise = invoice[amountColumn as keyof InvoiceDetail] as string | null;
    return paise === null ? null : formatPaiseString(paise);
  }
  const textColumn = TEXT_COLUMNS[name];
  if (!textColumn) return null;
  const value = invoice[textColumn as keyof InvoiceDetail];
  if (value instanceof Date) return isoDate(value);
  return (value as string | null) ?? null;
}

/**
 * A `date` column as the calendar day it actually is.
 *
 * Both drivers hand back a `date` as a JS Date at *local* midnight. East of
 * UTC that is the previous day in UTC terms, so `toISOString().slice(0, 10)`
 * renders 15/08 as 14/08 for every user in IST. Worse on the review screen,
 * where the shifted value seeds the form and a reviewer confirming an
 * unchanged field writes the wrong date back as a label. Read the local
 * getters, which are the ones that agree with what the driver parsed.
 */
export function isoDate(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatPaiseString(paise: string): string {
  const value = BigInt(paise);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  return `${negative ? "-" : ""}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
}

function normalise(value: string | null): string {
  return (value ?? "").trim();
}

function severityName(severity: Severity): string {
  return severity === Severity.Fatal ? "fatal" : severity === Severity.Error ? "error" : "warning";
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string; cause?: { code?: string } }).code
    ?? (error as { cause?: { code?: string } }).cause?.code;
  if (code === "23505") return true;
  return /duplicate key value violates unique constraint/i.test(String(error));
}

/** Whether to divert an otherwise auto-approvable invoice to a human. */
export function shouldAuditSample(rate: number, random = Math.random): boolean {
  return random() < rate;
}

export async function markAuditSample(id: string): Promise<void> {
  const database = await getDatabase();
  await database.query(
    "insert into audit_sample (invoice_id) values ($1) on conflict do nothing",
    [id],
  );
}
