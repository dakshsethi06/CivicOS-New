export type Role = "super_admin" | "city_admin" | "dept_officer" | "field_worker" | "citizen";

export const ROLE_LABEL: Record<Role, string> = {
  super_admin: "Super Administrator",
  city_admin: "City Administrator",
  dept_officer: "Department Officer",
  field_worker: "Field Worker",
  citizen: "Citizen",
};

export type NavItem = {
  href: string;
  label: string;
  icon: "dashboard" | "map" | "water" | "waste" | "traffic" | "complaints" | "assistant" | "insights" | "analytics" | "settings" | "platform";
  roles: Role[];
  /** Build phase that delivers this page. Items above the current phase render disabled. */
  phase: number;
  /** Shown instead of the phase tag when the page is off for a reason other than "not built yet". */
  disabledNote?: string;
};

const STAFF: Role[] = ["super_admin", "city_admin", "dept_officer"];

export const NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: "dashboard", roles: [...STAFF, "field_worker", "citizen"], phase: 0 },
  { href: "/map", label: "City Map", icon: "map", roles: [...STAFF, "field_worker"], phase: 1 },
  { href: "/water", label: "Water", icon: "water", roles: STAFF, phase: 1 },
  { href: "/complaints", label: "Complaints", icon: "complaints", roles: [...STAFF, "field_worker", "citizen"], phase: 1 },
  { href: "/waste", label: "Waste", icon: "waste", roles: STAFF, phase: 1 },
  { href: "/traffic", label: "Traffic", icon: "traffic", roles: STAFF, phase: 1 },
  { href: "/assistant", label: "Assistant", icon: "assistant", roles: [...STAFF, "field_worker", "citizen"], phase: 1 },
  { href: "/insights", label: "Insights", icon: "insights", roles: STAFF, phase: 1 },
  { href: "/analytics", label: "Analytics", icon: "analytics", roles: STAFF, phase: 1 },
  { href: "/settings", label: "Settings", icon: "settings", roles: ["super_admin", "city_admin"], phase: 0 },
  { href: "/admin", label: "Platform", icon: "platform", roles: ["super_admin"], phase: 0 },
];

/** Highest phase whose pages exist in this build. Raise it as phases ship. */
export const CURRENT_PHASE = 1;

export function navFor(role: Role) {
  return NAV.filter((item) => item.roles.includes(role));
}

export function canAccess(role: Role, href: string) {
  const item = NAV.find((n) => href === n.href || href.startsWith(n.href + "/"));
  return item ? item.roles.includes(role) : false;
}
