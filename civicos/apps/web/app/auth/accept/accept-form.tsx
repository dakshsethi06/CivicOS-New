"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { acceptInvitation } from "@/app/auth/actions";
import { createClient } from "@/lib/supabase/client";

type EmailOtpType = "invite" | "magiclink" | "signup" | "recovery" | "email";
const input = "w-full rounded-lg border border-line bg-raised px-3 py-2.5 text-sm text-ink focus:border-accent focus:outline-none";

/**
 * The invitation link signs the person in. Depending on the Supabase project's settings the session arrives as tokens
 * in the URL fragment, a one-time code, or a token hash; each is handled. Then they set a name and password and join.
 */
export function AcceptInvitation() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "saving" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createClient();
    (async () => {
      const hash = new URLSearchParams(window.location.hash.slice(1));
      const query = new URLSearchParams(window.location.search);
      if (hash.get("error_description") || query.get("error_description")) {
        throw new Error(hash.get("error_description") ?? query.get("error_description") ?? "The link is not valid.");
      }
      if (hash.get("access_token") && hash.get("refresh_token")) {
        const { error } = await supabase.auth.setSession({ access_token: hash.get("access_token")!, refresh_token: hash.get("refresh_token")! });
        if (error) throw error;
      } else if (query.get("code")) {
        const { error } = await supabase.auth.exchangeCodeForSession(query.get("code")!);
        if (error) throw error;
      } else if (query.get("token_hash")) {
        const { error } = await supabase.auth.verifyOtp({ token_hash: query.get("token_hash")!, type: (query.get("type") ?? "invite") as EmailOtpType });
        if (error) throw error;
      }
      window.history.replaceState(null, "", window.location.pathname);   // do not leave tokens in the address bar
      const { data } = await supabase.auth.getUser();
      if (!data.user) throw new Error("This invitation link has expired or was already used. Ask your administrator to invite you again.");
      setEmail(data.user.email ?? null);
      setState("ready");
    })().catch((e: unknown) => {
      setMessage(e instanceof Error ? e.message : "The invitation link could not be opened.");
      setState("error");
    });
  }, []);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const name = String(form.get("full_name") ?? "").trim();
    const password = String(form.get("password") ?? "");
    if (password.length < 8) return setMessage("The password must be at least 8 characters.");
    setState("saving");
    setMessage(null);
    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password, data: { full_name: name } });
    if (error) {
      setMessage(error.message);
      return setState("ready");
    }
    const r = await acceptInvitation(name);
    if (!r.ok) {
      setMessage(r.message ?? "The invitation could not be accepted.");
      return setState("ready");
    }
    await supabase.auth.refreshSession();          // a new token carrying the organization and role
    router.replace("/dashboard");
    router.refresh();
  }

  if (state === "loading") return <p className="mt-6 text-sm text-muted">Opening your invitation…</p>;
  if (state === "error") {
    return (
      <div className="mt-6 space-y-3">
        <p role="alert" className="rounded-lg border border-danger/40 px-3 py-2 text-sm text-danger">{message}</p>
        <a href="/login" className="text-sm text-accent hover:underline">Go to sign in</a>
      </div>
    );
  }
  return (
    <form onSubmit={submit} className="mt-6 space-y-4">
      {email ? <p className="text-sm text-muted">Signed in as <span className="text-ink">{email}</span></p> : null}
      <label className="block text-sm">
        <span className="mb-1.5 block font-medium text-ink">Your name</span>
        <input name="full_name" required className={input} autoComplete="name" />
      </label>
      <label className="block text-sm">
        <span className="mb-1.5 block font-medium text-ink">Choose a password</span>
        <input name="password" type="password" required minLength={8} className={input} autoComplete="new-password" />
      </label>
      {message ? <p role="alert" className="text-sm text-danger">{message}</p> : null}
      <button type="submit" disabled={state === "saving"}
              className="w-full rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-accent-ink disabled:opacity-60">
        {state === "saving" ? "Joining…" : "Accept and join"}
      </button>
    </form>
  );
}
