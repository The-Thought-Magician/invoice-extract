const LABELS: Record<string, { text: string; colour: string }> = {
  queued: { text: "queued", colour: "var(--muted)" },
  processing: { text: "processing", colour: "var(--muted)" },
  auto_approved: { text: "auto approved", colour: "var(--ok)" },
  awaiting_review: { text: "needs review", colour: "var(--warn)" },
  reviewed: { text: "reviewed", colour: "var(--ok)" },
  rejected: { text: "not an invoice", colour: "var(--stop)" },
  failed: { text: "failed", colour: "var(--stop)" },
};

export function StatusChip({ status }: { status: string }) {
  const label = LABELS[status] ?? { text: status, colour: "var(--muted)" };
  return (
    <span
      data-testid={`status-${status}`}
      className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[12px]"
      style={{ borderColor: label.colour, color: label.colour }}
    >
      <span
        aria-hidden
        className="h-1.5 w-1.5 rounded-full"
        style={{ background: label.colour }}
      />
      {label.text}
    </span>
  );
}
