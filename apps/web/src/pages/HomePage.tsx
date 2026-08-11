import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AppShell } from "@/components/AppShell";
import { api } from "@/lib/api";

export function HomePage() {
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    <AppShell>
      <main className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto px-5 py-10 md:px-8 md:py-14">
        <section className="animate-rise relative overflow-hidden rounded-[2rem] border border-line/60 bg-ink-soft/70 px-6 py-12 md:px-10 md:py-16">
          <div className="animate-pulse-line pointer-events-none absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-spark to-transparent" />
          <p className="font-display text-sm font-semibold uppercase tracking-[0.2em] text-spark">
            Studio
          </p>
          <h1 className="mt-4 font-display text-3xl font-extrabold leading-[1.05] tracking-tight text-paper md:text-5xl">
            Describe an app.
            <br />
            Watch it appear.
          </h1>
          <p className="mt-4 max-w-xl text-base text-fog">
            One prompt starts a workspace with live agent updates and a preview
            pane. Your projects live in the sidebar.
          </p>

          <form onSubmit={onCreate} className="mt-8 space-y-4">
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
      </main>
    </AppShell>
  );
}
