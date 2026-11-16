"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3, Bot, Building, Droplets, LayoutDashboard, Lightbulb, Map, MessageSquareWarning, Settings, TrafficCone, Trash2,
  type LucideIcon,
} from "lucide-react";
import { CURRENT_PHASE, type NavItem } from "@/lib/permissions";

const ICONS: Record<NavItem["icon"], LucideIcon> = {
  dashboard: LayoutDashboard,
  map: Map,
  water: Droplets,
  waste: Trash2,
  traffic: TrafficCone,
  complaints: MessageSquareWarning,
  assistant: Bot,
  insights: Lightbulb,
  analytics: BarChart3,
  settings: Settings,
  platform: Building,
};

export function SidebarNav({ items }: { items: NavItem[] }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Main" className="flex flex-col gap-0.5">
      {items.map((item) => {
        const Icon = ICONS[item.icon];
        const active = pathname === item.href || pathname.startsWith(item.href + "/");
        const base = "relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors duration-200";

        if (item.phase > CURRENT_PHASE) {
          return (
            <span key={item.href} aria-disabled="true" className={`${base} cursor-not-allowed text-faint`} title={item.disabledNote ?? `Arrives in phase ${item.phase}`}>
              <Icon className="size-4 shrink-0" aria-hidden="true" />
              <span className="flex-1">{item.label}</span>
              <span className="rounded border border-line px-1.5 py-px text-[10px] uppercase tracking-wide">{item.disabledNote ? "No data" : `P${item.phase}`}</span>
            </span>
          );
        }
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={`group ${base} ${active ? "bg-accent-soft font-medium text-accent" : "text-muted hover:bg-raised hover:text-ink"}`}
          >
            <span aria-hidden="true" className={`absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-accent transition-all duration-300 ${active ? "opacity-100" : "scale-y-0 opacity-0"}`} />
            <Icon className={`size-4 shrink-0 transition-transform duration-200 group-hover:scale-110 ${active ? "text-accent" : ""}`} aria-hidden="true" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
