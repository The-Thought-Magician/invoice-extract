/**
 * The Gemini adapter, tested against a stubbed fetch.
 *
 * generativelanguage.googleapis.com is unreachable from the build sandbox, so
 * these tests pin the request shape and the response handling rather than
 * calling the API. They are the contract: if Google changes the wire format,
 * these fail before production does.
 */

import { describe, expect, it, vi } from "vitest";

import { GeminiExtractionError, GeminiFieldExtractor, parseResponse } from "../src/gemini";

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);

function geminiSaying(fields: Record<string, string | null>): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify(fields) }] } }],
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

type FetchCall = [string, RequestInit];

/** A stub with the real fetch signature, so calls are typed when inspected. */
function stubFetch(
  respond: (call: number) => Response,
): ReturnType<typeof vi.fn<(url: string, init: RequestInit) => Promise<Response>>> {
  let calls = 0;
  return vi.fn(async (_url: string, _init: RequestInit) => respond(++calls));
}

function extractorWith(
  fetchImpl: ReturnType<typeof stubFetch>,
  maxRetries = 0,
): GeminiFieldExtractor {
  return new GeminiFieldExtractor({
    apiKey: "test-key",
    fetchImpl: fetchImpl as unknown as typeof fetch,
    maxRetries,
  });
}

describe("the request", () => {
  it("sends the PDF inline as base64 with the correct mime type", async () => {
    const fetchImpl = stubFetch(() => geminiSaying({ totalValue: "1180.00" }));
    await extractorWith(fetchImpl).extract(PDF);

    const body = JSON.parse((fetchImpl.mock.calls[0] as FetchCall)[1].body as string);
    const inline = body.contents[0].parts[1].inline_data;
    expect(inline.mime_type).toBe("application/pdf");
    expect(Buffer.from(inline.data, "base64")).toEqual(Buffer.from(PDF));
  });

  it("puts the API key in a header, never in the URL", async () => {
    const fetchImpl = stubFetch(() => geminiSaying({}));
    await extractorWith(fetchImpl).extract(PDF);

    const [url, init] = fetchImpl.mock.calls[0] as FetchCall;
    expect(url).not.toContain("test-key");
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe("test-key");
  });

  it("constrains the model to a JSON schema covering every field", async () => {
    const fetchImpl = stubFetch(() => geminiSaying({}));
    await extractorWith(fetchImpl).extract(PDF);

    const body = JSON.parse((fetchImpl.mock.calls[0] as FetchCall)[1].body as string);
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseSchema.required).toContain("supplierGstin");
    expect(body.generationConfig.responseSchema.required).toContain("totalValue");
  });

  it("never asks the model for a confidence score", async () => {
    // ADR 0001. Putting the field in the schema would invite someone to gate on it.
    const fetchImpl = stubFetch(() => geminiSaying({}));
    await extractorWith(fetchImpl).extract(PDF);

    const raw = (fetchImpl.mock.calls[0] as FetchCall)[1].body as string;
    expect(raw.toLowerCase()).not.toContain("confidence");
  });

  it("uses a non-zero temperature so independent runs are actually independent", async () => {
    const fetchImpl = stubFetch(() => geminiSaying({}));
    await extractorWith(fetchImpl).extract(PDF);

    const body = JSON.parse((fetchImpl.mock.calls[0] as FetchCall)[1].body as string);
    expect(body.generationConfig.temperature).toBeGreaterThan(0);
  });
});

describe("parsing the response", () => {
  it("reads the field values out of the candidate text part", () => {
    const run = parseResponse({
      candidates: [{ content: { parts: [{ text: '{"totalValue":"1180.00"}' }] } }],
    });
    expect(run.totalValue).toBe("1180.00");
  });

  it("treats an omitted field as absent rather than undefined", () => {
    const run = parseResponse({
      candidates: [{ content: { parts: [{ text: "{}" }] } }],
    });
    expect(run.supplierGstin).toBeNull();
  });

  it("treats the literal string null as absent", () => {
    // Models do this. Storing "null" as a GSTIN would be a silent corruption.
    const run = parseResponse({
      candidates: [{ content: { parts: [{ text: '{"supplierGstin":"null"}' }] } }],
    });
    expect(run.supplierGstin).toBeNull();
  });

  it("treats an empty string as absent", () => {
    const run = parseResponse({
      candidates: [{ content: { parts: [{ text: '{"hsn":"   "}' }] } }],
    });
    expect(run.hsn).toBeNull();
  });

  it("trims surrounding whitespace from a value", () => {
    const run = parseResponse({
      candidates: [{ content: { parts: [{ text: '{"invoiceNumber":"  INV/1  "}' }] } }],
    });
    expect(run.invoiceNumber).toBe("INV/1");
  });

  it("ignores a non-string value rather than coercing it", () => {
    const run = parseResponse({
      candidates: [{ content: { parts: [{ text: '{"totalValue":1180}' }] } }],
    });
    expect(run.totalValue).toBeNull();
  });

  it("throws when there is no text part", () => {
    expect(() => parseResponse({ candidates: [] })).toThrow(GeminiExtractionError);
  });

  it("throws when the text part is not JSON", () => {
    expect(() =>
      parseResponse({ candidates: [{ content: { parts: [{ text: "I cannot help" }] } }] }),
    ).toThrow(GeminiExtractionError);
  });
});

describe("failure handling", () => {
  it("retries a 429 and succeeds on a later attempt", async () => {
    const fetchImpl = stubFetch((call) =>
      call === 1
        ? new Response("rate limited", { status: 429 })
        : geminiSaying({ totalValue: "1180.00" }),
    );

    const run = await extractorWith(fetchImpl, 2).extract(PDF);
    expect(run.totalValue).toBe("1180.00");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries a 500", async () => {
    const fetchImpl = stubFetch((call) =>
      call === 1 ? new Response("boom", { status: 503 }) : geminiSaying({ totalValue: "1.00" }),
    );
    await extractorWith(fetchImpl, 2).extract(PDF);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 400, which will not improve", async () => {
    const fetchImpl = stubFetch(() => new Response("bad request", { status: 400 }));

    await expect(extractorWith(fetchImpl, 3).extract(PDF)).rejects.toThrow(
      GeminiExtractionError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 403, so a blocked key fails fast", async () => {
    const fetchImpl = stubFetch(() => new Response("forbidden", { status: 403 }));

    await expect(extractorWith(fetchImpl, 3).extract(PDF)).rejects.toThrow(/403/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses to construct without an API key", () => {
    expect(() => new GeminiFieldExtractor({ apiKey: "" })).toThrow(GeminiExtractionError);
  });
});
