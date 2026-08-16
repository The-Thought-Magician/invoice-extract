import { readFile } from "node:fs/promises";

import { NextResponse } from "next/server";

import { getDatabase } from "@/lib/db";
import { storagePath } from "@/lib/storage";

export const runtime = "nodejs";

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const database = await getDatabase();
  const { rows } = await database.query<{ storage_key: string }>(
    "select storage_key from invoice where id = $1",
    [id],
  );
  const key = rows[0]?.storage_key;
  if (!key) return NextResponse.json({ error: "not found" }, { status: 404 });

  const bytes = await readFile(storagePath(key));
  return new NextResponse(new Uint8Array(bytes), {
    headers: { "content-type": "application/pdf", "cache-control": "private, max-age=60" },
  });
}
