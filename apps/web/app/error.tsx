"use client";

/**
 * Both pages read the database directly during render, so a store failure
 * surfaces here. Without this the user gets Next's default error screen with no
 * way back to the list.
 */
export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <div className="card px-5 py-6">
        <h1 className="text-[15px] font-semibold tracking-tight">Something failed to load</h1>
        <p className="mt-2 text-[13px]" style={{ color: "var(--muted)" }}>
          Nothing was lost. Uploaded invoices are stored and will still be there.
        </p>
        <div className="mt-4 flex items-center gap-3">
          <button
            type="button"
            onClick={reset}
            className="rounded-md px-3.5 py-1.5 text-[13px] font-medium text-white"
            style={{ background: "var(--accent)" }}
          >
            Try again
          </button>
          <a className="text-[13px] underline" href="/">
            All invoices
          </a>
        </div>
      </div>
    </main>
  );
}
