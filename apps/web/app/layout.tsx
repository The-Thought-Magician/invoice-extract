import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Invoice extraction",
  description: "Read the numbers off a GST invoice without opening the PDF",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <header className="border-b hairline">
          <div className="mx-auto flex max-w-6xl items-baseline gap-3 px-6 py-4">
            <a href="/" className="text-[15px] font-semibold tracking-tight">
              Invoice extraction
            </a>
            <span className="text-[13px]" style={{ color: "var(--muted)" }}>
              GST tax invoices, header fields
            </span>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
