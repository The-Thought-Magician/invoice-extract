import { readFile } from "node:fs/promises";

import { NextResponse } from "next/server";

import { getDatabase } from "@/lib/db";
import { storagePath } from "@/lib/storage";
import { isInvoiceId } from "@/lib/store";

export const runtime = "nodejs";

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!isInvoiceId(id)) return NextResponse.json({ error: "not found" }, { status: 404 });

  const database = await getDatabase();
  const { rows } = await database.query<{ storage_key: string }>(
    "select storage_key from invoice where id = $1",
    [id],
  );
  const key = rows[0]?.storage_key;
  if (!key) return NextResponse.json({ error: "not found" }, { status: 404 });

  // A row can outlive its file. That is a missing document, not a broken
  // server, and the review screen embeds this URL in an <object>.
  let bytes: Buffer;
  try {
    bytes = await readFile(storagePath(key));
  } catch {
    return NextResponse.json({ error: "stored file is missing" }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(bytes), {
    headers: { "content-type": "application/pdf", "cache-control": "private, max-age=60" },
  });
}
