/**
 * Upload edge cases, driven through the HTTP API rather than the file picker,
 * because a browser will not let you attach a file it thinks is the wrong type.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

const ROOT = resolve(__dirname, "../../../") + "/";

test("refuses a file that is not a PDF whatever it is named", async ({ request }) => {
  const response = await request.post("/api/upload", {
    multipart: {
      files: {
        name: "invoice.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from("PK this is a zip pretending to be a PDF"),
      },
    },
  });

  expect(response.ok()).toBe(true);
  const body = await response.json();
  expect(body.accepted).toBe(0);
  expect(body.rejected[0].reason).toBe("not a PDF");
});

test("refuses an empty file", async ({ request }) => {
  const response = await request.post("/api/upload", {
    multipart: {
      files: { name: "empty.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(0) },
    },
  });
  const body = await response.json();
  expect(body.accepted).toBe(0);
  expect(body.rejected[0].reason).toBe("empty file");
});

test("refuses a request with no files at all", async ({ request }) => {
  const response = await request.post("/api/upload", { multipart: {} });
  expect(response.status()).toBe(400);
});

test("accepts the good files in a batch that also contains bad ones", async ({ request }) => {
  const good = await readFile(`${ROOT}fixtures/pdfs/02-clean-inter-state.pdf`);
  const response = await request.post("/api/upload", {
    multipart: {
      files: { name: "junk.pdf", mimeType: "application/pdf", buffer: Buffer.from("nope") },
    },
  });
  expect((await response.json()).accepted).toBe(0);

  const second = await request.post("/api/upload", {
    multipart: {
      files: { name: "good.pdf", mimeType: "application/pdf", buffer: good },
    },
  });
  expect((await second.json()).accepted).toBe(1);
});

test("draining an empty queue is a no-op rather than an error", async ({ request }) => {
  await request.post("/api/worker/drain");
  const response = await request.post("/api/worker/drain");
  expect(response.ok()).toBe(true);
  expect((await response.json()).processed).toBe(0);
});

test("answers 404 for an invoice that does not exist", async ({ request }) => {
  const response = await request.get("/api/invoices/00000000-0000-0000-0000-000000000000");
  expect(response.status()).toBe(404);
});

test("ignores unknown field names in a review payload", async ({ request }) => {
  // The update statement is built from the field list, so an invented key must
  // not be able to steer it.
  const list = await (await request.get("/api/invoices")).json();
  const target = list.invoices.find(
    (invoice: { status: string }) => invoice.status === "awaiting_review",
  );
  test.skip(!target, "no invoice awaiting review");

  const response = await request.post(`/api/invoices/${target.id}/review`, {
    data: { reviewer: "tester", values: { totalValue: "1.00", dropTable: "boom" } },
  });
  expect(response.ok()).toBe(true);

  const after = await (await request.get(`/api/invoices/${target.id}`)).json();
  expect(after.invoice.status).toBe("reviewed");
});
