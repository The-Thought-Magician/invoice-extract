/**
 * Where uploaded PDFs live.
 *
 * The local filesystem for now. The rest of the application only ever sees an
 * opaque storage key, so moving to object storage is a change to this file.
 */

import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(process.env.STORAGE_DIR ?? join(process.cwd(), ".storage"));

export function storagePath(key: string): string {
  const path = resolve(ROOT, key);
  // A storage key comes from the database, but treating it as trusted input is
  // how directory traversal happens. Refuse anything that escapes the root, and
  // the root itself: an empty key resolves to the directory, and reading that
  // fails with EISDIR rather than saying what actually went wrong.
  if (path === ROOT || !path.startsWith(ROOT + "/")) {
    throw new Error("storage key escapes the storage root");
  }
  return path;
}

export async function store(bytes: Uint8Array): Promise<string> {
  const key = `${randomUUID()}.pdf`;
  await mkdir(ROOT, { recursive: true });
  await writeFile(storagePath(key), bytes);
  return key;
}

/**
 * Delete a stored file. Used when the row that would have referenced it could
 * not be written, so the bytes are not left behind with nothing pointing at
 * them. Never throws: the caller is already handling a failure.
 */
export async function discard(key: string): Promise<void> {
  try {
    await rm(storagePath(key), { force: true });
  } catch {
    // Nothing useful to do; the original error is the one worth reporting.
  }
}

/** A PDF starts with %PDF-. Anything else is not one, whatever it is named. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const header = new TextDecoder().decode(bytes.subarray(0, 5));
  return header === "%PDF-";
}
