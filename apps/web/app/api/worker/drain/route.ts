import { NextResponse } from "next/server";

import { configFromEnvironment, drainQueue } from "@/lib/worker";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Drain the queue.
 *
 * Called by the upload panel so a person watching gets a result promptly, and
 * intended to be called on a schedule in production. Safe to call
 * concurrently: claiming uses `for update skip locked`.
 */
export async function POST() {
  const processed = await drainQueue(configFromEnvironment());
  return NextResponse.json({ processed });
}
