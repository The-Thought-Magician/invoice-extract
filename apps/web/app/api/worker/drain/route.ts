import { NextResponse } from "next/server";

import { releaseStranded } from "@/lib/store";
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

  // Reclaim anything a dead worker left claimed before looking for new work,
  // otherwise those invoices are lost to both the queue and the review list.
  try {
    await releaseStranded();
  } catch {
    // Best effort. Failing to reclaim must not stop the queue from draining.
  }

  try {
    const id = await processOne(config);
    return NextResponse.json({ processed: id ? 1 : 0, id });
  } catch (error) {
    // processOne already records per-invoice failures. Reaching here means the
    // worker itself is broken, and a 500 would make the client's loop retry
    // forever. Report zero processed so it stops.
    return NextResponse.json(
      {
        processed: 0,
        error: error instanceof Error ? error.message : "worker failed",
      },
      { status: 500 },
    );
  }
}
