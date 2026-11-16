"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { createApiKey, type KeyState } from "@/app/(app)/settings/actions";

/** Creates a key and shows it once, in the page only (never in the URL). */
export function ApiKeyForm() {
  const [state, action, pending] = useActionState<KeyState, FormData>(createApiKey, {});
  const router = useRouter();
  useEffect(() => {
    if (state.key) router.refresh(); // update the key list underneath
  }, [state.key, router]);

  return (
    <div>
      <form action={action} className="flex flex-wrap items-end gap-3">
        <label className="block min-w-0 flex-1 text-xs text-muted">
          Key name
          <input name="name" required placeholder="Open data portal" className="mt-1 w-full rounded-lg border border-line bg-raised px-3 py-2 text-sm text-ink placeholder:text-faint focus:border-accent focus:outline-none" />
        </label>
        <button type="submit" disabled={pending} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-ink hover:brightness-110 disabled:opacity-50">
          {pending ? "Creating…" : "Create key"}
        </button>
      </form>
      {state.error ? <p role="alert" className="mt-3 text-sm text-danger">{state.error}</p> : null}
      {state.key ? (
        <div role="status" className="mt-3 rounded-lg border border-accent/40 bg-accent/10 p-3 text-sm">
          <p className="text-ink">Copy this key now. It is stored only as a hash and cannot be shown again.</p>
          <code className="mt-2 block overflow-x-auto rounded bg-base px-3 py-2 font-mono text-xs text-ink">{state.key}</code>
        </div>
      ) : null}
    </div>
  );
}
