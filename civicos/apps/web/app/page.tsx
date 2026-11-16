import Link from "next/link";
import { Activity, Droplets, MapPinned, MessagesSquare } from "lucide-react";
import { Logo } from "@/components/logo";

const pillars = [
  { icon: Activity, title: "Data intelligence", text: "One view of complaints, water, waste and air quality across every ward." },
  { icon: Droplets, title: "Published figures only", text: "Complaints, waste, water and air quality by ward, each traced to its source table." },
  { icon: MapPinned, title: "Geospatial map", text: "Every ward compared on an interactive map of the city." },
  { icon: MessagesSquare, title: "Cited answers", text: "An assistant that answers from municipal documents and shows its sources." },
];

export default function Landing() {
  return (
    <div className="hero-bg">
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col px-6">
      <header className="flex items-center justify-between py-6">
        <Logo />
        <nav className="flex items-center gap-3 text-sm">
          <Link href="/join" className="rounded-lg px-3 py-2 text-muted hover:text-ink">
            Report a problem
          </Link>
          <Link href="/login" className="rounded-lg px-3 py-2 text-muted hover:text-ink">
            Sign in
          </Link>
          <Link href="/register" className="press rounded-lg bg-accent px-4 py-2 font-semibold text-accent-ink shadow-sm shadow-accent/20 transition hover:brightness-110 hover:shadow-md">
            Register a municipality
          </Link>
        </nav>
      </header>

      <section className="page-enter-flat flex flex-1 flex-col justify-center py-16">
        <p className="mb-4 text-sm font-medium uppercase tracking-[0.18em] text-accent">Urban intelligence platform</p>
        <h1 className="max-w-3xl text-5xl font-semibold leading-[1.08] tracking-tight sm:text-6xl">Intelligence for <span className="text-gradient">Better Cities.</span></h1>
        <p className="mt-6 max-w-2xl text-lg leading-relaxed text-muted">
          CivicOS turns municipal data into decisions: which wards wait longest for complaints to close, where water
          supply is shortest, where waste is growing, and when the air is worst.
        </p>

        <div className="stagger mt-14 grid gap-4 sm:grid-cols-2">
          {pillars.map(({ icon: Icon, title, text }) => (
            <div key={title} className="card-hover rounded-xl border border-line bg-panel p-5">
              <span className="mb-3 grid size-9 place-items-center rounded-lg bg-accent-soft">
                <Icon className="size-5 text-accent" aria-hidden="true" />
              </span>
              <h2 className="font-medium">{title}</h2>
              <p className="mt-1 text-sm leading-relaxed text-muted">{text}</p>
            </div>
          ))}
        </div>
      </section>

      <footer className="border-t border-line py-6 text-xs text-faint">
        Mumbai build. Every figure is taken from published reports on Brihanmumbai Municipal Corporation data, with the source table cited beside each chart.
      </footer>
    </main>
    </div>
  );
}
