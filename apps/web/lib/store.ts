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

import { getDatabase } from "./db";

export type InvoiceStatus =
  | "queued"
  | "processing"
  | "auto_approved"
  | "awaiting_review"
  | "reviewed"
  | "rejected"
  | "failed";

export interface InvoiceRow {
  id: string;
  original_name: string;
  status: InvoiceStatus;
  uploaded_at: string;
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
    `update invoice set status = 'processing'
     where id = (
       select id from invoice where status = 'queued'
       order by uploaded_at limit 1 for update skip locked
     )
     returning id, storage_key`,
  );
  return rows[0] ?? null;
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
    ...Object.keys(TEXT_COLUMNS).map((name) => extraction[name as FieldName].value),
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

  try {
    await database.query(
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
    if (isUniqueViolation(error)) {
      const original = key === null ? null : await findByDuplicateKey(key, input.id);
      await database.query(
        `update invoice set status = 'rejected', processed_at = now(), route = 'reject',
           route_reasons = $2 where id = $1`,
        [
          input.id,
          [
            `duplicate: this supplier already issued invoice ${extraction.invoiceNumber.value} in this financial year`,
          ],
        ],
      );
      return { status: "rejected", duplicateOf: original };
    }
    throw error;
  }

  await database.query("delete from finding where invoice_id = $1", [input.id]);
  for (const finding of input.findings) {
    await database.query(
      `insert into finding (invoice_id, code, severity, field_name, message)
       values ($1, $2, $3, $4, $5)`,
      [input.id, finding.code, severityName(finding.severity), finding.field, finding.message],
    );
  }

  await database.query("delete from extraction_run where invoice_id = $1", [input.id]);
  for (const [index, raw] of input.rawRuns.entries()) {
    await database.query(
      `insert into extraction_run (invoice_id, run_index, model, prompt_hash, raw_output)
       values ($1, $2, $3, $4, $5::jsonb)`,
      [input.id, index, input.model, input.promptHash, JSON.stringify(raw)],
    );
  }

  return { status, duplicateOf: null };
}

export function computeDuplicateKey(extraction: InvoiceExtraction): string | null {
  const supplier = extraction.supplierGstin.value;
  const number = extraction.invoiceNumber.value;
  const date = extraction.invoiceDate.value;
  if (!supplier || !number || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return duplicateKey(supplier, number, date);
}

async function findByDuplicateKey(key: string, exclude: string): Promise<string | null> {
  const database = await getDatabase();
  const { rows } = await database.query<{ id: string }>(
    "select id from invoice where duplicate_key = $1 and id <> $2 limit 1",
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

export async function getInvoice(id: string): Promise<InvoiceDetail | null> {
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

  for (const name of FIELD_NAMES) {
    if (!(name in input.values)) continue;
    const corrected = input.values[name] ?? null;
    const extracted = currentValue(before, name);
    await database.query(
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
      parameters.push(raw);
      assignments.push(`${textColumn} = $${parameters.length}`);
    }
  }

  await database.query(
    `update invoice set status = 'reviewed'${assignments.length ? ", " + assignments.join(", ") : ""}
     where id = $1`,
    parameters,
  );

  await database.query(
    `update audit_sample set resolved_at = now(),
       found_error = exists (
         select 1 from correction where invoice_id = $1 and was_correct = false
       )
     where invoice_id = $1`,
    [input.id],
  );
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
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return (value as string | null) ?? null;
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
