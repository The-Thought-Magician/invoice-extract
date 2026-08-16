import { NextResponse } from "next/server";

import { createInvoice } from "@/lib/store";
import { discard, looksLikePdf, store } from "@/lib/storage";

export const runtime = "nodejs";

/**
 * Caps on what one request may hand us.
 *
 * `next.config.mjs` sets a body limit for Server Actions, which does not apply
 * to a Route Handler. Without these, `formData()` buffers the whole upload,
 * `arrayBuffer()` materialises each file again, and the base64 encoding for
 * Gemini makes a third copy at 4/3 the size. A single large POST is then enough
 * to exhaust the process, which presents as an unresponsive server, not as a
 * rejected upload.
 */
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 50;
const MAX_REQUEST_BYTES = 200 * 1024 * 1024;

/**
 * Accept files and return immediately.
 *
 * Nothing here calls Gemini or Tesseract. The row exists, the queue drains
 * later, the uploader comes back. That is the whole reason upload is fast at
 * five invoices a day and still fast at a thousand.
 */
export async function POST(request: Request) {
  // Refuse an oversized body before buffering it, not after.
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_REQUEST_BYTES) {
    return NextResponse.json({ error: "upload too large" }, { status: 413 });
  }

  let files: File[];
  try {
    const form = await request.formData();
    files = form.getAll("files").filter((entry): entry is File => entry instanceof File);
  } catch {
    return NextResponse.json({ error: "malformed multipart body" }, { status: 400 });
  }

  if (files.length === 0) {
    return NextResponse.json({ error: "no files" }, { status: 400 });
  }
  if (files.length > MAX_FILES) {
    return NextResponse.json(
      { error: `too many files in one upload (max ${MAX_FILES})` },
      { status: 413 },
    );
  }

  const accepted: string[] = [];
  const rejected: Array<{ name: string; reason: string }> = [];

  for (const file of files) {
    // A rejected file must not sink the ones already stored. The uploader needs
    // to know exactly what was taken, so per-file failures are reported rather
    // than thrown.
    try {
      if (file.size > MAX_FILE_BYTES) {
        rejected.push({ name: file.name, reason: "larger than 25MB" });
        continue;
      }

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
      try {
        accepted.push(
          await createInvoice({
            storageKey,
            originalName: file.name,
            uploadedBy: request.headers.get("x-user") ?? "uploader",
          }),
        );
      } catch (error) {
        // The bytes are on disk but no row points at them. Drop the file rather
        // than leave it to be collected by nobody.
        await discard(storageKey);
        throw error;
      }
    } catch (error) {
      rejected.push({
        name: file.name,
        reason: error instanceof Error ? error.message : "could not be stored",
      });
    }
  }

  return NextResponse.json({ accepted: accepted.length, ids: accepted, rejected });
}
