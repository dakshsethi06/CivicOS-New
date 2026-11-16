"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** While a background job runs, refreshes the page every few seconds so its progress and results appear. */
export function JobWatcher({ running }: { running: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(t);
  }, [running, router]);
  return null;
}
