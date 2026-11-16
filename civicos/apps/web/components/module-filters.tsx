"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

const selectCls = "h-9 rounded-lg border border-line bg-raised px-2.5 text-sm text-ink focus:border-accent focus:outline-none";

/** Ward and year pickers for a module page. State lives in the URL. */
export function ModuleFilters({
  wards, ward, years, year, yearLabel = "Year",
}: { wards: { id: string; name: string }[]; ward: string | null; years?: number[]; year?: number; yearLabel?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  function update(key: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    startTransition(() => router.replace(`${pathname}?${next.toString()}`, { scroll: false }));
  }

  return (
    <div className={`flex flex-wrap items-end gap-3 rounded-xl border border-line bg-panel p-3 ${pending ? "opacity-60" : ""}`} aria-busy={pending}>
      <label className="flex flex-col gap-1 text-xs text-muted">
        Ward
        <select className={selectCls} value={ward ?? ""} onChange={(e) => update("zone", e.target.value)}>
          <option value="">All wards</option>
          {wards.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
      </label>
      {years && year ? (
        <label className="flex flex-col gap-1 text-xs text-muted">
          {yearLabel}
          <select className={selectCls} value={year} onChange={(e) => update("year", e.target.value)}>
            {[...years].reverse().map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </label>
      ) : null}
    </div>
  );
}
