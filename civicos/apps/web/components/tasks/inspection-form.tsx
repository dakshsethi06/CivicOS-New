"use client";

import { useState } from "react";
import { submitInspection } from "@/app/(app)/tasks/actions";
import { CONDITIONS } from "@/lib/tasks";

const input = "w-full rounded-lg border border-line bg-raised px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none";

/** The field report: condition, findings, action taken, photo and location. Works on a phone. */
export function InspectionForm({ task, complaint, canComplete }: { task?: string; complaint?: string; canComplete?: boolean }) {
  const [pos, setPos] = useState<{ lat: number; lon: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [locNote, setLocNote] = useState<string | null>(null);

  function locate() {
    if (!navigator.geolocation) return setLocNote("This browser cannot share a location.");
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (p) => { setPos({ lat: +p.coords.latitude.toFixed(6), lon: +p.coords.longitude.toFixed(6) }); setLocating(false); setLocNote(null); },
      (e) => { setLocNote(e.message || "The location could not be read."); setLocating(false); },
      { enableHighAccuracy: true, timeout: 15000 },
    );
  }

  return (
    <form action={submitInspection} className="space-y-3">
      {task ? <input type="hidden" name="task" value={task} /> : null}
      {complaint ? <input type="hidden" name="complaint" value={complaint} /> : null}
      <input type="hidden" name="lat" value={pos?.lat ?? ""} />
      <input type="hidden" name="lon" value={pos?.lon ?? ""} />
      <label className="block text-xs text-muted">
        Condition found
        <select name="condition" required defaultValue="" className={`mt-1 ${input}`}>
          <option value="" disabled>Choose…</option>
          {CONDITIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
        </select>
      </label>
      <label className="block text-xs text-muted">
        What you found
        <textarea name="findings" required rows={3} className={`mt-1 ${input}`} placeholder="For example: joint cracked, steady leak onto the road" />
      </label>
      <label className="block text-xs text-muted">
        Action taken (optional)
        <textarea name="action_taken" rows={2} className={`mt-1 ${input}`} placeholder="For example: clamp fitted, area barricaded" />
      </label>
      <label className="block text-xs text-muted">
        Photo (optional)
        <input name="photo" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="mt-1 block w-full text-sm text-muted file:mr-3 file:rounded file:border file:border-line file:bg-raised file:px-3 file:py-1.5 file:text-ink" />
      </label>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button type="button" onClick={locate} className="rounded border border-line px-2.5 py-1 text-muted hover:text-ink">
          {locating ? "Locating…" : pos ? "Update my location" : "Add my location"}
        </button>
        {pos ? <span className="tabular-nums text-muted">{pos.lat}, {pos.lon}</span> : null}
        {locNote ? <span className="text-warn">{locNote}</span> : null}
      </div>
      <label className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" name="followup" className="size-4 accent-[#0d8f78]" /> Needs follow-up work</label>
      {canComplete ? (
        <label className="flex items-center gap-2 text-sm text-ink"><input type="checkbox" name="complete" defaultChecked className="size-4 accent-[#0d8f78]" /> Mark the task done</label>
      ) : null}
      <button type="submit" className="w-full rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:brightness-110">Submit report</button>
    </form>
  );
}
