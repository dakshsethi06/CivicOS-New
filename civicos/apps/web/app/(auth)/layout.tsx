import Link from "next/link";
import { Logo } from "@/components/logo";

export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <main className="hero-bg flex min-h-screen flex-col items-center justify-center px-6 py-12">
      <Link href="/" className="animate-fade mb-8">
        <Logo size={32} />
      </Link>
      <div className="animate-pop w-full max-w-sm [&>div]:shadow-xl [&>div]:shadow-slate-900/5">{children}</div>
    </main>
  );
}
