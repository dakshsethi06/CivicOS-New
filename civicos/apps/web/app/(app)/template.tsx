/** Re-mounts on every navigation, so each page's blocks rise in when it opens. */
export default function AppTemplate({ children }: { children: React.ReactNode }) {
  return <div className="page-enter">{children}</div>;
}
