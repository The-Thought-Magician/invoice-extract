"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

type Phase = "idle" | "uploading" | "processing" | "done" | "error";

/**
 * Consecutive drain failures tolerated before the loop gives up. Without a cap
 * a server that is down keeps the tab POSTing until it is closed.
 */
const MAX_CONSECUTIVE_FAILURES = 5;

export function UploadPanel() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string>("");

  // One drain loop at a time, and none at all once the panel is gone. Selecting
  // files twice must not leave two loops racing to declare the queue empty.
  const draining = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /**
   * Drain the queue one invoice per request.
   *
   * The route processes a single invoice and returns, so the server stays
   * answerable between them and the list fills in as the work happens. Draining
   * everything in one request is what made the server unreachable for minutes.
   */
  async function drain(skipped: string) {
    if (draining.current) return;
    draining.current = true;
    let failures = 0;

    try {
      while (alive.current) {
        try {
          const response = await fetch("/api/worker/drain", { method: "POST" });
          if (!response.ok) throw new Error(`drain returned ${response.status}`);
          const { processed } = (await response.json()) as { processed?: number };
          failures = 0;
          if (!alive.current) return;
          router.refresh();
          // Anything other than a positive count means the queue is empty or
          // the response was not the shape we expect. Either way, stop.
          if (typeof processed !== "number" || processed <= 0) break;
        } catch {
          failures += 1;
          if (failures >= MAX_CONSECUTIVE_FAILURES) {
            if (alive.current) {
              setPhase("error");
              setMessage("Processing stalled. Reload to retry the remaining invoices.");
            }
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }

      if (!alive.current) return;
      setPhase("done");
      setMessage(`Done.${skipped}`);
      router.refresh();
    } finally {
      draining.current = false;
    }
  }

  async function submit(files: FileList | null) {
    if (!files || files.length === 0) return;

    setPhase("uploading");
    setMessage(`Uploading ${files.length} file${files.length === 1 ? "" : "s"}`);

    const body = new FormData();
    for (const file of Array.from(files)) body.append("files", file);

    try {
      const response = await fetch("/api/upload", { method: "POST", body });
      // Read `ok` before the body: an error page is not JSON, and parsing it
      // first surfaces a parser message instead of the actual failure.
      if (!response.ok) throw new Error(`upload failed (${response.status})`);
      const result = (await response.json()) as {
        accepted: number;
        rejected: { name: string; reason: string }[];
      };

      const skipped = result.rejected.length
        ? ` Skipped ${result.rejected.map((r) => `${r.name} (${r.reason})`).join(", ")}.`
        : "";
      setPhase("processing");
      setMessage(`Accepted ${result.accepted}. Reading them now.${skipped}`);
      router.refresh();

      void drain(skipped);
    } catch (error) {
      setPhase("error");
      setMessage(error instanceof Error ? error.message : "upload failed");
    } finally {
      if (input.current) input.current.value = "";
    }
  }

  return (
    <section className="card px-5 py-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-[15px] font-semibold tracking-tight">Upload invoices</h2>
          <p className="text-[13px]" style={{ color: "var(--muted)" }}>
            PDFs, digital or scanned. Reading happens in the background, so you can close
            this and come back.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <input
            ref={input}
            type="file"
            name="files"
            accept="application/pdf"
            multiple
            data-testid="file-input"
            onChange={(event) => void submit(event.target.files)}
            className="block text-[13px] file:mr-3 file:cursor-pointer file:rounded-md file:border file:px-3 file:py-1.5 file:text-[13px]"
            style={{ color: "var(--muted)" }}
          />
        </div>
      </div>

      {phase !== "idle" && (
        <p
          data-testid="upload-status"
          data-phase={phase}
          role="status"
          aria-live="polite"
          className="mt-4 border-t hairline pt-3 text-[13px]"
          style={{ color: phase === "error" ? "var(--stop)" : "var(--muted)" }}
        >
          {message}
        </p>
      )}
    </section>
  );
}
