import { listInvoices, formatPaiseString, isoDate, type InvoiceRow } from "@/lib/store";

import { UploadPanel } from "./upload-panel";
import { StatusChip } from "./status-chip";

export const dynamic = "force-dynamic";

export default async function Home() {
  const invoices = await listInvoices();
  const counts = tally(invoices);

  return (
    <div className="space-y-8">
      <UploadPanel />

      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
          <h2 className="text-[15px] font-semibold tracking-tight">Invoices</h2>
          <p className="text-[13px]" style={{ color: "var(--muted)" }} data-testid="counts">
            {invoices.length} total &middot; {counts.awaiting_review} awaiting review &middot;{" "}
            {counts.auto_approved} auto approved &middot; {counts.rejected} rejected
          </p>
        </div>

        {invoices.length === 0 ? (
          <p className="card px-4 py-8 text-center text-[13px]" style={{ color: "var(--muted)" }}>
            Nothing uploaded yet.
          </p>
        ) : (
          <div className="card overflow-hidden">
            <table className="w-full text-[13px]" data-testid="invoice-table">
              <thead>
                <tr className="border-b hairline text-left" style={{ color: "var(--muted)" }}>
                  <th className="px-4 py-2.5 font-medium">File</th>
                  <th className="px-4 py-2.5 font-medium">Supplier GSTIN</th>
                  <th className="px-4 py-2.5 font-medium">Invoice no.</th>
                  <th className="px-4 py-2.5 font-medium">Date</th>
                  <th className="px-4 py-2.5 text-right font-medium">Total</th>
                  <th className="px-4 py-2.5 font-medium">Source</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((invoice) => (
                  <tr
                    key={invoice.id}
                    className="border-b hairline last:border-0"
                    data-testid={`row-${invoice.original_name}`}
                  >
                    <td className="px-4 py-2.5">
                      <a
                        href={`/invoices/${invoice.id}`}
                        className="underline underline-offset-2"
                      >
                        {invoice.original_name}
                      </a>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-[12px]">
                      {invoice.supplier_gstin ?? "—"}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-[12px]">
                      {invoice.invoice_number ?? "—"}
                    </td>
                    <td className="px-4 py-2.5">{formatDate(invoice.invoice_date)}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-[12px]">
                      {invoice.total_value_paise != null
                        ? formatPaiseString(invoice.total_value_paise)
                        : "—"}
                    </td>
                    <td className="px-4 py-2.5" style={{ color: "var(--muted)" }}>
                      {invoice.had_text_layer === null
                        ? "—"
                        : invoice.had_text_layer
                          ? "digital"
                          : "scan"}
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusChip status={invoice.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function tally(invoices: InvoiceRow[]): Record<string, number> {
  const counts: Record<string, number> = {
    queued: 0,
    awaiting_review: 0,
    auto_approved: 0,
    reviewed: 0,
    rejected: 0,
    failed: 0,
  };
  for (const invoice of invoices) counts[invoice.status] = (counts[invoice.status] ?? 0) + 1;
  return counts;
}

/**
 * Both drivers hand back a `date` column as a JS Date, not a string, so this
 * cannot assume it is dealing with text. Rendered DD/MM/YYYY because that is
 * how an Indian invoice prints it and how the reviewer will read the page.
 */
function formatDate(value: unknown): string {
  if (value === null || value === undefined) return "—";
  // isoDate reads the local getters. toISOString would shift the day backwards
  // for every user east of UTC, because a `date` arrives as local midnight.
  const iso = value instanceof Date ? isoDate(value) : String(value).slice(0, 10);
  const [year, month, day] = iso.split("-");
  return year && month && day ? `${day}/${month}/${year}` : iso;
}
