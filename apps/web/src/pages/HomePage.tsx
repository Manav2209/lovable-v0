import { type FormEvent, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { TopBar } from "@/components/Brand";
import { api, type Project } from "@/lib/api";

export function HomePage() {
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.listProjects();
        if (!cancelled) setProjects(res.data || []);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load projects");
        }
      } finally {
        if (!cancelled) setLoadingList(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    if (prompt.trim().length < 10) {
      setError("Prompt must be at least 10 characters");
      return;
    }
    setError(null);
    setCreating(true);
    try {
      const res = await api.createProject(prompt.trim());
      const projectId = res.data?.projectId;
      if (!projectId) throw new Error("No project id returned");
      navigate(`/project/${projectId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="min-h-screen">
      <TopBar />

      <main className="mx-auto max-w-5xl px-5 py-10 md:px-8 md:py-16">
        <section className="animate-rise relative overflow-hidden rounded-[2rem] border border-line/60 bg-ink-soft/70 px-6 py-14 md:px-12 md:py-20">
          <div className="animate-pulse-line pointer-events-none absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-spark to-transparent" />
          <p className="font-display text-sm font-semibold uppercase tracking-[0.2em] text-spark">
            Lovable
          </p>
          <h1 className="mt-4 max-w-3xl font-display text-4xl font-extrabold leading-[1.05] tracking-tight text-paper md:text-6xl">
            Describe an app.
            <br />
            Watch it appear.
          </h1>
          <p className="mt-5 max-w-xl text-base text-fog md:text-lg">
            One prompt starts a project workspace with live agent updates and a
            preview pane.
          </p>

          <form onSubmit={onCreate} className="mt-10 space-y-4">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              placeholder="Build a landing page for a pottery studio with a booking form…"
              className="w-full resize-y rounded-2xl border border-line bg-ink/80 px-5 py-4 text-base text-paper outline-none ring-spark/30 placeholder:text-fog/60 focus:ring-2"
            />
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                disabled={creating}
                className="rounded-full bg-spark px-6 py-3 font-semibold text-ink transition hover:bg-spark-deep disabled:opacity-60"
              >
                {creating ? "Creating project…" : "Create project"}
              </button>
              <span className="text-sm text-fog">Min 10 characters</span>
            </div>
          </form>

          {error ? (
            <p className="mt-4 rounded-lg border border-ember/40 bg-ember/10 px-3 py-2 text-sm text-ember">
              {error}
            </p>
          ) : null}
        </section>

        <section className="animate-rise-delay mt-14">
          <div className="mb-5 flex items-end justify-between gap-4">
            <h2 className="font-display text-2xl font-bold text-paper">
              Your projects
            </h2>
            <span className="text-sm text-fog">
              {loadingList ? "Loading…" : `${projects.length} total`}
            </span>
          </div>

          {loadingList ? (
            <p className="text-fog">Fetching projects…</p>
          ) : projects.length === 0 ? (
            <p className="text-fog">No projects yet — start with a prompt above.</p>
          ) : (
            <ul className="divide-y divide-line/80 border-y border-line/80">
              {projects.map((p) => (
                <li key={p.id}>
                  <Link
                    to={`/project/${p.id}`}
                    className="flex items-center justify-between gap-4 py-4 transition hover:text-spark"
                  >
                    <div>
                      <p className="font-medium text-paper">{p.title}</p>
                      <p className="mt-1 line-clamp-1 text-sm text-fog">
                        {p.initialPrompt}
                      </p>
                    </div>
                    <span className="shrink-0 text-sm text-fog">Open →</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
