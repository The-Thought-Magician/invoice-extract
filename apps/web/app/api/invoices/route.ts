import { NextResponse } from "next/server";

import { asInvoiceStatus, listInvoices } from "@/lib/store";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const requested = new URL(request.url).searchParams.get("status");
  const status = asInvoiceStatus(requested);
  // An unrecognised status would reach Postgres as a bad enum literal and come
  // back as an unhandled 500. It is a bad request, so say so.
  if (requested !== null && status === null) {
    return NextResponse.json({ error: `unknown status: ${requested}` }, { status: 400 });
  }
  return NextResponse.json({ invoices: await listInvoices(status ?? undefined) });
}
