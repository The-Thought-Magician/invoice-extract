"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export interface ReviewField {
  name: string;
  label: string;
  value: string | null;
  grounded: string;
  samples: string[];
  findings: Array<{ code: string; severity: string; message: string }>;
}

export function ReviewForm({
  invoiceId,
  fields,
  readOnly,
}: {
  invoiceId: string;
  fields: ReviewField[];
  readOnly: boolean;
}) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(fields.map((f) => [f.name, f.value ?? ""])),
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/invoices/${invoiceId}/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reviewer: "reviewer",
          values: Object.fromEntries(
            Object.entries(values).map(([key, value]) => [key, value.trim() || null]),
          ),
        }),
      });
      if (!response.ok) {
        // Surface why. A reviewer's corrections are the only ground truth this
        // system has; losing them silently is worse than refusing the save.
        const detail = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(detail?.error ?? `save failed (${response.status})`);
      }
      setSaved(true);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card px-5 py-5" data-testid="review-form">
      <div className="mb-4 flex items-baseline justify-between gap-3">
        <h2 className="text-[15px] font-semibold tracking-tight">Extracted fields</h2>
        <p className="text-[12px]" style={{ color: "var(--muted)" }}>
          Confirming an unchanged value is also a label
        </p>
      </div>

      <div className="space-y-3">
        {fields.map((field) => {
          const disagreed = new Set(field.samples).size > 1;
          const ungrounded = field.value !== null && field.grounded !== "true";
          return (
            <div key={field.name} data-testid={`field-${field.name}`}>
              <div className="mb-1 flex flex-wrap items-baseline gap-2">
                <label
                  htmlFor={field.name}
                  className="text-[13px] font-medium"
                  style={{ minWidth: "9rem" }}
                >
                  {field.label}
                </label>
                {ungrounded && (
                  <Flag testId={`ungrounded-${field.name}`} colour="var(--warn)">
                    not found on the page
                  </Flag>
                )}
                {disagreed && (
                  <Flag testId={`disagreed-${field.name}`} colour="var(--warn)">
                    runs disagreed: {field.samples.join(" / ")}
                  </Flag>
                )}
                {field.findings.map((finding) => (
                  <Flag
                    key={finding.code}
                    testId={`finding-${finding.code}`}
                    colour={finding.severity === "warning" ? "var(--warn)" : "var(--stop)"}
                  >
                    {finding.message}
                  </Flag>
                ))}
              </div>
              <input
                id={field.name}
                name={field.name}
                data-testid={`input-${field.name}`}
                disabled={readOnly}
                value={values[field.name] ?? ""}
                onChange={(event) => {
                  setSaved(false);
                  setValues((previous) => ({
                    ...previous,
                    [field.name]: event.target.value,
                  }));
                }}
                className="w-full rounded-md border px-2.5 py-1.5 font-mono text-[13px] disabled:opacity-50"
                style={{ borderColor: "var(--line)", background: "transparent" }}
              />
            </div>
          );
        })}
      </div>

      {!readOnly && (
        <div className="mt-5 flex items-center gap-3 border-t hairline pt-4">
          <button
            type="button"
            data-testid="save-review"
            disabled={saving}
            onClick={() => void save()}
            className="rounded-md px-3.5 py-1.5 text-[13px] font-medium text-white disabled:opacity-60"
            style={{ background: "var(--accent)" }}
          >
            {saving ? "Saving" : "Confirm and save"}
          </button>
          <span role="status" aria-live="polite" className="text-[13px]">
            {saved && (
              <span data-testid="save-confirmation" style={{ color: "var(--ok)" }}>
                Saved. Every field is now a labelled example.
              </span>
            )}
          </span>
          {error && (
            <span
              data-testid="save-error"
              role="alert"
              className="text-[13px]"
              style={{ color: "var(--stop)" }}
            >
              Not saved: {error}
            </span>
          )}
        </div>
      )}
    </section>
  );
}

function Flag({
  children,
  colour,
  testId,
}: {
  children: React.ReactNode;
  colour: string;
  testId: string;
}) {
  return (
    <span
      data-testid={testId}
      className="rounded border px-1.5 py-0.5 text-[11px]"
      style={{ borderColor: colour, color: colour }}
    >
      {children}
    </span>
  );
}
