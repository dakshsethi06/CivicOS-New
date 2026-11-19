export type Role = "super_admin" | "city_admin" | "dept_officer" | "field_worker" | "citizen";

export const ROLE_LABEL: Record<Role, string> = {
  super_admin: "Super Administrator",
  city_admin: "City Administrator",
  dept_officer: "Department Officer",
  field_worker: "Field Worker",
  citizen: "Citizen",
};

export type NavGroup = "Overview" | "Services" | "Work" | "Intelligence" | "Admin";

export type NavItem = {
  href: string;
  label: string;
  icon: "dashboard" | "map" | "water" | "waste" | "traffic" | "complaints" | "tasks" | "assistant" | "insights" | "analytics" | "settings" | "platform";
  roles: Role[];
  /** Sidebar section heading. Items of one group are listed together. */
  group: NavGroup;
  /** Build phase that delivers this page. Items above the current phase render disabled. */
  phase: number;
  /** Shown instead of the phase tag when the page is off for a reason other than "not built yet". */
  disabledNote?: string;
};

const STAFF: Role[] = ["super_admin", "city_admin", "dept_officer"];

export const NAV: NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: "dashboard", group: "Overview", roles: [...STAFF, "field_worker", "citizen"], phase: 0 },
  { href: "/map", label: "City Map", icon: "map", group: "Overview", roles: [...STAFF, "field_worker"], phase: 1 },
  { href: "/water", label: "Water", icon: "water", group: "Services", roles: STAFF, phase: 1 },
  { href: "/waste", label: "Waste", icon: "waste", group: "Services", roles: STAFF, phase: 1 },
  { href: "/traffic", label: "Traffic", icon: "traffic", group: "Services", roles: STAFF, phase: 1 },
  { href: "/complaints", label: "Complaints", icon: "complaints", group: "Work", roles: [...STAFF, "field_worker", "citizen"], phase: 1 },
  { href: "/tasks", label: "Tasks", icon: "tasks", group: "Work", roles: [...STAFF, "field_worker"], phase: 1 },
  { href: "/assistant", label: "Assistant", icon: "assistant", group: "Intelligence", roles: [...STAFF, "field_worker", "citizen"], phase: 1 },
  { href: "/insights", label: "Insights", icon: "insights", group: "Intelligence", roles: STAFF, phase: 1 },
  { href: "/analytics", label: "Analytics", icon: "analytics", group: "Intelligence", roles: STAFF, phase: 1 },
  { href: "/settings", label: "Settings", icon: "settings", group: "Admin", roles: ["super_admin", "city_admin"], phase: 0 },
  { href: "/admin", label: "Platform", icon: "platform", group: "Admin", roles: ["super_admin"], phase: 0 },
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
