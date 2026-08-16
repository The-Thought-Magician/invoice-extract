import { NextResponse } from "next/server";

import { configFromEnvironment, processOne } from "@/lib/worker";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Process one queued invoice and return immediately.
 *
 * The upload panel fires this then polls; each call processes one invoice so
 * the server stays responsive between them. The panel re-triggers until the
 * queue is empty.
 */
export async function POST() {
  const config = configFromEnvironment();
  const id = await processOne(config);
  return NextResponse.json({ processed: id ? 1 : 0, id });
}
