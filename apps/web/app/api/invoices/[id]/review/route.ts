import { NextResponse } from "next/server";

import { FIELD_NAMES, type FieldName } from "@invoice-extract/core";

import { isInvoiceId, promptHashFor, recordReview } from "@/lib/store";
import { configFromEnvironment } from "@/lib/worker";

export const runtime = "nodejs";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!isInvoiceId(id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  let body: { reviewer?: string; values?: Record<string, string | null> };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }

  // Only known field names are accepted, so a caller cannot steer the update
  // statement by inventing keys.
  const values: Partial<Record<FieldName, string | null>> = {};
  for (const name of FIELD_NAMES) {
    if (body.values && name in body.values) values[name] = body.values[name] ?? null;
  }

  // The reviewer is the ground truth this system is built to collect, so a date
  // they type has to be a date. Saying so beats silently discarding it, which
  // would record a confident label for a value that was never stored.
  const date = values.invoiceDate;
  if (date != null && date !== "" && !ISO_DATE.test(date)) {
    return NextResponse.json(
      { error: "invoiceDate must be YYYY-MM-DD" },
      { status: 400 },
    );
  }

  const config = configFromEnvironment();
  try {
    await recordReview({
      id,
      reviewer: body.reviewer?.trim() || "unknown",
      values,
      model: config.model,
      // The configuration that produced the values being judged, not this one.
      promptHash: (await promptHashFor(id)) ?? config.model,
    });
  } catch (error) {
    if (error instanceof Error && /no invoice/.test(error.message)) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    throw error;
  }

  return NextResponse.json({ ok: true });
}
