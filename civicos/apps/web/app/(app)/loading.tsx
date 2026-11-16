/** Shown while a page's data loads: the page's shape, shimmering. */
export default function Loading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading">
      <div className="space-y-2">
        <div className="skeleton h-7 w-64" />
        <div className="skeleton h-4 w-96 max-w-full" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="rounded-xl border border-line bg-panel p-4">
            <div className="skeleton h-4 w-28" />
            <div className="skeleton mt-3 h-8 w-24" />
            <div className="skeleton mt-3 h-3 w-36" />
          </div>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {[0, 1].map((i) => (
          <div key={i} className="rounded-xl border border-line bg-panel p-5">
            <div className="skeleton h-4 w-48" />
            <div className="skeleton mt-5 h-56 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
