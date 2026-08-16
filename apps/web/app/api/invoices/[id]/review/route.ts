import { NextResponse } from "next/server";

import { FIELD_NAMES, type FieldName } from "@invoice-extract/core";

import { recordReview } from "@/lib/store";
import { configFromEnvironment } from "@/lib/worker";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const body = (await request.json()) as {
    reviewer?: string;
    values?: Record<string, string | null>;
  };

  // Only known field names are accepted, so a caller cannot steer the update
  // statement by inventing keys.
  const values: Partial<Record<FieldName, string | null>> = {};
  for (const name of FIELD_NAMES) {
    if (body.values && name in body.values) values[name] = body.values[name] ?? null;
  }

  const config = configFromEnvironment();
  await recordReview({
    id,
    reviewer: body.reviewer?.trim() || "unknown",
    values,
    model: config.model,
    promptHash: "review",
  });

  return NextResponse.json({ ok: true });
}
