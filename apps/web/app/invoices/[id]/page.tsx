import { notFound } from "next/navigation";

import { formatPaiseString, getInvoice, isoDate, type InvoiceDetail } from "@/lib/store";

import { StatusChip } from "../../status-chip";
import { ReviewForm, type ReviewField } from "./review-form";

export const dynamic = "force-dynamic";

const LABELS: Record<string, string> = {
  supplierGstin: "Supplier GSTIN",
  recipientGstin: "Recipient GSTIN",
  invoiceNumber: "Invoice number",
  invoiceDate: "Invoice date",
  placeOfSupplyStateCode: "Place of supply",
  taxableValue: "Taxable value",
  cgstAmount: "CGST",
  sgstAmount: "SGST",
  igstAmount: "IGST",
  cessAmount: "Cess",
  totalValue: "Total",
  hsn: "HSN / SAC",
};

const COLUMNS: Record<string, keyof InvoiceDetail> = {
  supplierGstin: "supplier_gstin",
  recipientGstin: "recipient_gstin",
  invoiceNumber: "invoice_number",
  invoiceDate: "invoice_date",
  placeOfSupplyStateCode: "place_of_supply_state_code",
  hsn: "hsn",
  taxableValue: "taxable_value_paise",
  cgstAmount: "cgst_amount_paise",
  sgstAmount: "sgst_amount_paise",
  igstAmount: "igst_amount_paise",
  cessAmount: "cess_amount_paise",
  totalValue: "total_value_paise",
};

const AMOUNTS = new Set([
  "taxableValue",
  "cgstAmount",
  "sgstAmount",
  "igstAmount",
  "cessAmount",
  "totalValue",
]);

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const invoice = await getInvoice(id);
  if (!invoice) return notFound();

  const fields: ReviewField[] = Object.keys(LABELS).map((name) => {
    const column = COLUMNS[name] as keyof InvoiceDetail;
    const raw = invoice[column];
    const value =
      raw === null || raw === undefined
        ? null
        : AMOUNTS.has(name)
          ? formatPaiseString(String(raw))
          : raw instanceof Date
            ? // Local getters, not toISOString: this value seeds the review
              // form, so a UTC shift would have the reviewer confirm — and
              // therefore label — a date one day earlier than the document's.
              isoDate(raw)
            : String(raw);

    const evidence = invoice.field_evidence?.[name];
    return {
      name,
      label: LABELS[name] as string,
      value,
      grounded: evidence?.grounded ?? "not-attempted",
      samples: evidence?.samples ?? [],
      findings: invoice.findings.filter((f) => f.field_name === name),
    };
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="space-y-1">
          <a href="/" className="text-[13px] underline underline-offset-2">
            All invoices
          </a>
          <h1 className="text-[17px] font-semibold tracking-tight">{invoice.original_name}</h1>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[12px]" style={{ color: "var(--muted)" }}>
            {invoice.had_text_layer === null
              ? ""
              : invoice.had_text_layer
                ? "digital PDF"
                : "scanned, read by OCR"}
          </span>
          <StatusChip status={invoice.status} />
        </div>
      </div>

      {invoice.route_reasons?.length > 0 && (
        <section className="card px-5 py-4" data-testid="reasons">
          <h2 className="mb-2 text-[13px] font-semibold">Why this was routed here</h2>
          <ul className="space-y-1 text-[13px]" style={{ color: "var(--muted)" }}>
            {invoice.route_reasons.map((reason, index) => (
              <li key={index} className="flex gap-2">
                <span aria-hidden>&middot;</span>
                <span>{reason}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="card overflow-hidden" data-testid="pdf-panel">
          <object
            data={`/api/invoices/${invoice.id}/pdf`}
            type="application/pdf"
            className="h-[720px] w-full"
            aria-label="Invoice PDF"
          >
            <p className="p-4 text-[13px]">
              <a href={`/api/invoices/${invoice.id}/pdf`}>Open the PDF</a>
            </p>
          </object>
        </section>

        <ReviewForm
          invoiceId={invoice.id}
          fields={fields}
          readOnly={invoice.status === "rejected"}
        />
      </div>
    </div>
  );
}
