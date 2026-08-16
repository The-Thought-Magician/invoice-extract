"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

type Phase = "idle" | "uploading" | "processing" | "done" | "error";

export function UploadPanel() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string>("");

  async function submit(files: FileList | null) {
    if (!files || files.length === 0) return;

    setPhase("uploading");
    setMessage(`Uploading ${files.length} file${files.length === 1 ? "" : "s"}`);

    const body = new FormData();
    for (const file of Array.from(files)) body.append("files", file);

    try {
      const response = await fetch("/api/upload", { method: "POST", body });
      const result = (await response.json()) as {
        accepted: number;
        rejected: { name: string; reason: string }[];
      };
      if (!response.ok) throw new Error("upload failed");

      // Upload returns as soon as the rows exist. Extraction happens after,
      // which is why the person is told to come back rather than made to wait.
      setPhase("processing");
      setMessage(`Accepted ${result.accepted}. Reading them now.`);
      await fetch("/api/worker/drain", { method: "POST" });

      const skipped = result.rejected.length
        ? ` Skipped ${result.rejected.map((r) => `${r.name} (${r.reason})`).join(", ")}.`
        : "";
      setPhase("done");
      setMessage(`Done.${skipped}`);
      router.refresh();
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
          className="mt-4 border-t hairline pt-3 text-[13px]"
          style={{ color: phase === "error" ? "var(--stop)" : "var(--muted)" }}
        >
          {message}
        </p>
      )}
    </section>
  );
}
