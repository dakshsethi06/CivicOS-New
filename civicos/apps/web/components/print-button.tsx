"use client";

import { Printer } from "lucide-react";

/** Opens the browser's print dialog, where "Save as PDF" produces a PDF of the page. */
export function PrintButton() {
  return (
    <button type="button" onClick={() => window.print()} className="inline-flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm text-ink hover:bg-raised print:hidden">
      <Printer className="size-4" aria-hidden="true" />
      Print or save as PDF
    </button>
  );
}
