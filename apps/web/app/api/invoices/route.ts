import { NextResponse } from "next/server";

import { listInvoices, type InvoiceStatus } from "@/lib/store";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const status = new URL(request.url).searchParams.get("status");
  return NextResponse.json({ invoices: await listInvoices(status as InvoiceStatus | undefined) });
}
