import type { Metadata } from "next";
import { AcceptInvitation } from "./accept-form";

export const metadata: Metadata = { title: "Accept invitation" };

export default function AcceptPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Join your team on CivicOS</h1>
      <p className="mt-1 text-sm text-muted">Set your name and a password to accept the invitation.</p>
      <AcceptInvitation />
    </main>
  );
}
