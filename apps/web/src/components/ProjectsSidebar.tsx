import { useEffect, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { api, type Project } from "@/lib/api";

const PAGE_SIZE = 5;
const COLLAPSE_KEY = "lovable_sidebar_collapsed";

type ProjectsSidebarProps = {
  collapsed: boolean;
  onToggle: () => void;
};

export function ProjectsSidebar({ collapsed, onToggle }: ProjectsSidebarProps) {
  const location = useLocation();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.listProjects();
        if (!cancelled) {
          setProjects(res.data || []);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load projects");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [location.pathname]);

  const visible = projects.slice(0, visibleCount);
  const hasMore = visibleCount < projects.length;

  return (
    <aside
      className={`flex h-full shrink-0 flex-col border-r border-line/70 bg-ink/40 transition-[width] duration-300 ease-out ${
        collapsed ? "w-[4.25rem]" : "w-64"
      }`}
    >
      <div
        className={`flex items-center border-b border-line/70 px-3 py-3 ${
          collapsed ? "justify-center" : "justify-between gap-2"
        }`}
      >
        {!collapsed ? (
          <p className="font-display text-sm font-semibold tracking-wide text-paper">
            Projects
          </p>
        ) : null}
        <button
          type="button"
          onClick={onToggle}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className="rounded-lg border border-line px-2.5 py-1.5 text-sm text-fog transition hover:border-spark hover:text-spark"
        >
          {collapsed ? "»" : "«"}
        </button>
      </div>

      <div className="px-2 py-3">
        <NavLink
          to="/studio"
          end
          title="New project"
          className={({ isActive }) =>
            `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition ${
              isActive
                ? "bg-spark/15 text-spark"
                : "text-fog hover:bg-ink-soft hover:text-paper"
            } ${collapsed ? "justify-center" : ""}`
          }
        >
          <span className="text-base leading-none">+</span>
          {!collapsed ? <span>New project</span> : null}
        </NavLink>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {loading ? (
          <p className={`px-3 py-2 text-sm text-fog ${collapsed ? "text-center" : ""}`}>
            {collapsed ? "…" : "Loading…"}
          </p>
        ) : error ? (
          <p className={`px-3 py-2 text-xs text-ember ${collapsed ? "sr-only" : ""}`}>
            {error}
          </p>
        ) : projects.length === 0 ? (
          !collapsed ? (
            <p className="px-3 py-2 text-sm text-fog">No projects yet.</p>
          ) : null
        ) : (
          <ul className="space-y-1">
            {visible.map((p) => (
              <li key={p.id}>
                <NavLink
                  to={`/project/${p.id}`}
                  title={p.title}
                  className={({ isActive }) =>
                    `block rounded-xl px-3 py-2.5 transition ${
                      isActive
                        ? "bg-panel text-paper"
                        : "text-fog hover:bg-ink-soft hover:text-paper"
                    }`
                  }
                >
                  {collapsed ? (
                    <span className="block text-center font-display text-sm font-semibold">
                      {(p.title || "P").charAt(0).toUpperCase()}
                    </span>
                  ) : (
                    <>
                      <p className="line-clamp-1 text-sm font-medium text-paper">
                        {p.title}
                      </p>
                      <p className="mt-0.5 line-clamp-1 text-xs text-fog/80">
                        {p.initialPrompt}
                      </p>
                    </>
                  )}
                </NavLink>
              </li>
            ))}
          </ul>
        )}

        {!collapsed && hasMore ? (
          <button
            type="button"
            onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}
            className="mt-3 w-full rounded-xl border border-line/80 px-3 py-2 text-sm text-fog transition hover:border-spark hover:text-spark"
          >
            Show more ({projects.length - visibleCount} left)
          </button>
        ) : null}

        {!collapsed && !hasMore && projects.length > PAGE_SIZE ? (
          <button
            type="button"
            onClick={() => setVisibleCount(PAGE_SIZE)}
            className="mt-3 w-full px-3 py-2 text-sm text-fog transition hover:text-spark"
          >
            Show less
          </button>
        ) : null}
      </div>

      {!collapsed ? (
        <div className="border-t border-line/70 px-4 py-3 text-xs text-fog">
          {projects.length} project{projects.length === 1 ? "" : "s"}
        </div>
      ) : (
        <Link
          to="/studio"
          className="border-t border-line/70 px-2 py-3 text-center text-xs text-fog hover:text-spark"
          title="Studio"
        >
          ···
        </Link>
      )}
    </aside>
  );
}

export function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === "1";
    } catch {
      return false;
    }
  });

  function toggle() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  return { collapsed, toggle };
}
