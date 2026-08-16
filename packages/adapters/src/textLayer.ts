/**
 * Producing a text layer for the grounding check.
 *
 * A digital PDF already has one. A scan does not, so its pages are rasterised
 * and run through Tesseract. Roughly half the corpus is scans, so the OCR path
 * is the normal path, not the exception.
 *
 * Tesseract's output is deliberately never used as the extracted value. It
 * exists only to answer "is this string on the page". An OCR misread therefore
 * makes a correct value look ungrounded and sends it to a human, which costs
 * reviewer time; it can never promote a wrong value. See ADR 0006.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { TextLayerReader } from "@invoice-extract/core";

const run = promisify(execFile);

/**
 * Wall-clock ceiling on each external tool.
 *
 * Without one, a PDF that makes tesseract or poppler spin never settles: the
 * drain request never responds, and the invoice stays claimed as 'processing'
 * with nothing to release it. Generous enough for a slow scan at 300 dpi;
 * exceeding it means something is wrong, not merely slow. `execFile` kills the
 * child on timeout and rejects, which the caller already treats as a failure.
 */
const TOOL_TIMEOUT_MS = 120_000;

/**
 * Below this many characters we treat the embedded text layer as absent. A
 * scanned page often still carries a stray character or two from the scanner
 * software, which is not a text layer in any useful sense.
 */
const MINIMUM_USEFUL_TEXT_LENGTH = 40;

export interface TextLayerResult {
  readonly text: string;
  readonly source: "embedded" | "ocr" | "none";
}

export interface PdfTextLayerOptions {
  /** Rasterisation resolution for OCR. Below 200 dpi accuracy falls off fast. */
  readonly dpi?: number;
  /** Tesseract language packs, e.g. "eng" or "eng+hin". */
  readonly language?: string;
}

export class PdfTextLayerReader implements TextLayerReader {
  private readonly dpi: number;
  private readonly language: string;

  constructor(options: PdfTextLayerOptions = {}) {
    this.dpi = options.dpi ?? 300;
    this.language = options.language ?? "eng";
  }

  async read(pdf: Uint8Array): Promise<string> {
    return (await this.readDetailed(pdf)).text;
  }

  /** As `read`, but says where the text came from so it can be recorded. */
  async readDetailed(pdf: Uint8Array): Promise<TextLayerResult> {
    const workingDirectory = await mkdtemp(join(tmpdir(), "invoice-text-"));
    const pdfPath = join(workingDirectory, "input.pdf");
    try {
      await writeFile(pdfPath, pdf);

      const embedded = await this.embeddedText(pdfPath);
      if (embedded.trim().length >= MINIMUM_USEFUL_TEXT_LENGTH) {
        return { text: embedded, source: "embedded" };
      }

      const ocr = await this.ocrText(pdfPath, workingDirectory);
      if (ocr.trim().length > 0) return { text: ocr, source: "ocr" };

      // Neither path produced anything. Nothing can be grounded, so every
      // field will route to review. That is the correct outcome, not a crash.
      return { text: "", source: "none" };
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  }

  private async embeddedText(pdfPath: string): Promise<string> {
    try {
      const { stdout } = await run("pdftotext", ["-layout", pdfPath, "-"], {
        maxBuffer: 32 * 1024 * 1024,
        timeout: TOOL_TIMEOUT_MS,
      });
      return stdout;
    } catch {
      return "";
    }
  }

  private async ocrText(pdfPath: string, workingDirectory: string): Promise<string> {
    const prefix = join(workingDirectory, "page");
    try {
      await run("pdftoppm", ["-png", "-r", String(this.dpi), pdfPath, prefix], {
        maxBuffer: 64 * 1024 * 1024,
        timeout: TOOL_TIMEOUT_MS,
      });
    } catch {
      return "";
    }

    const pages = (await readdir(workingDirectory))
      .filter((name) => name.startsWith("page") && name.endsWith(".png"))
      .sort();

    const texts: string[] = [];
    for (const page of pages) {
      try {
        const { stdout } = await run(
          "tesseract",
          [join(workingDirectory, page), "stdout", "-l", this.language, "--psm", "6"],
          { maxBuffer: 32 * 1024 * 1024, timeout: TOOL_TIMEOUT_MS },
        );
        texts.push(stdout);
      } catch {
        // A page that fails to OCR contributes nothing rather than failing the
        // document. Its fields simply will not ground.
      }
    }
    return texts.join("\n");
  }
}

/** Reads a text layer that has already been produced. Used by tests and replay. */
export class StaticTextLayerReader implements TextLayerReader {
  constructor(private readonly text: string) {}
  async read(): Promise<string> {
    return this.text;
  }
}

export async function readFixture(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(path));
}
