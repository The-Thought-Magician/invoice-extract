import { NextResponse } from "next/server";

import { getInvoice } from "@/lib/store";

export const runtime = "nodejs";

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const invoice = await getInvoice(id);
  if (!invoice) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ invoice });
}
