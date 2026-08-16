import { NextResponse } from "next/server";

import { createInvoice } from "@/lib/store";
import { looksLikePdf, store } from "@/lib/storage";

export const runtime = "nodejs";

/**
 * Accept files and return immediately.
 *
 * Nothing here calls Gemini or Tesseract. The row exists, the queue drains
 * later, the uploader comes back. That is the whole reason upload is fast at
 * five invoices a day and still fast at a thousand.
 */
export async function POST(request: Request) {
  const form = await request.formData();
  const files = form.getAll("files").filter((entry): entry is File => entry instanceof File);

  if (files.length === 0) {
    return NextResponse.json({ error: "no files" }, { status: 400 });
  }

  const accepted: string[] = [];
  const rejected: Array<{ name: string; reason: string }> = [];

  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length === 0) {
      rejected.push({ name: file.name, reason: "empty file" });
      continue;
    }
    // Trust the bytes, not the extension or the browser's mime guess.
    if (!looksLikePdf(bytes)) {
      rejected.push({ name: file.name, reason: "not a PDF" });
      continue;
    }

    const storageKey = await store(bytes);
    accepted.push(
      await createInvoice({
        storageKey,
        originalName: file.name,
        uploadedBy: request.headers.get("x-user") ?? "uploader",
      }),
    );
  }

  return NextResponse.json({ accepted: accepted.length, ids: accepted, rejected });
}
