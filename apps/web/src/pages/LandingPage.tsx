import { Link } from "react-router-dom";
import { BrandMark } from "@/components/Brand";
import { useAuth } from "@/lib/auth";

export function LandingPage() {
  const { isAuthenticated } = useAuth();
  const primaryHref = isAuthenticated ? "/studio" : "/signup";
  const primaryLabel = isAuthenticated ? "Go to studio" : "Start building";

  return (
    <div className="relative min-h-screen overflow-x-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_20%_20%,rgba(198,240,77,0.16),transparent_45%),radial-gradient(ellipse_at_80%_10%,rgba(255,122,69,0.1),transparent_40%),linear-gradient(180deg,transparent_55%,rgba(0,0,0,0.45))]"
      />

      <header className="relative z-10 flex items-center justify-between px-6 py-5 md:px-10">
        <BrandMark />
        <nav className="flex items-center gap-3 text-sm">
          {isAuthenticated ? (
            <Link
              to="/studio"
              className="rounded-full bg-spark px-5 py-2.5 font-semibold text-ink transition hover:bg-spark-deep"
            >
              Open studio
            </Link>
          ) : (
            <>
              <Link
                to="/login"
                className="rounded-full border border-line px-4 py-2 text-paper transition hover:border-spark hover:text-spark"
              >
                Sign in
              </Link>
              <Link
                to="/signup"
                className="rounded-full bg-spark px-5 py-2.5 font-semibold text-ink transition hover:bg-spark-deep"
              >
                Get started
              </Link>
            </>
          )}
        </nav>
      </header>

      {/* Hero — one composition */}
      <main className="relative z-10">
        <section className="relative mx-auto flex min-h-[calc(100vh-5.5rem)] max-w-6xl flex-col justify-center px-6 pb-20 pt-8 md:px-10 md:pb-28">
          <div
            aria-hidden
            className="animate-pulse-line pointer-events-none absolute inset-x-6 top-[12%] h-px bg-gradient-to-r from-transparent via-spark/50 to-transparent md:inset-x-10"
          />

          <div className="animate-rise max-w-3xl">
            <h1 className="font-display text-5xl font-extrabold leading-[0.98] tracking-tight text-paper md:text-7xl lg:text-8xl">
              Lovable
              <span className="text-spark">.</span>
            </h1>
            <p className="mt-6 max-w-xl text-lg text-fog md:text-xl">
              Describe an app in one prompt. Watch a live agent build it — with
              a preview that updates as you go.
            </p>
            <div className="mt-10 flex flex-wrap items-center gap-4">
              <Link
                to={primaryHref}
                className="rounded-full bg-spark px-7 py-3.5 font-semibold text-ink transition hover:bg-spark-deep"
              >
                {primaryLabel}
              </Link>
              {!isAuthenticated ? (
                <Link
                  to="/login"
                  className="text-sm text-fog transition hover:text-paper"
                >
                  Already have an account →
                </Link>
              ) : null}
            </div>
          </div>

          <div
            aria-hidden
            className="animate-rise-delay animate-drift pointer-events-none relative mt-16 max-w-4xl overflow-hidden rounded-[2rem] border border-line/50 bg-ink-soft/60"
          >
            <div className="flex items-center gap-2 border-b border-line/60 px-5 py-3">
              <span className="h-2.5 w-2.5 rounded-full bg-ember/70" />
              <span className="h-2.5 w-2.5 rounded-full bg-spark/50" />
              <span className="h-2.5 w-2.5 rounded-full bg-fog/40" />
              <span className="ml-3 text-xs tracking-wide text-fog">
                preview.localhost
              </span>
            </div>
            <div className="grid gap-0 md:grid-cols-[0.9fr_1.1fr]">
              <div className="space-y-3 border-b border-line/50 px-5 py-6 md:border-b-0 md:border-r">
                <p className="text-[11px] uppercase tracking-[0.18em] text-spark">
                  Live agent
                </p>
                <p className="text-sm text-fog">planning → createFile</p>
                <p className="text-sm text-fog">stitchApp → preview_ready</p>
                <p className="text-sm text-paper/90">Build a pottery studio landing page…</p>
              </div>
              <div className="relative min-h-40 bg-gradient-to-br from-spark/15 via-transparent to-ember/15 px-5 py-8 md:min-h-48">
                <p className="font-display text-2xl font-bold text-paper/90 md:text-3xl">
                  Your app,
                  <br />
                  mid-flight.
                </p>
                <p className="mt-3 max-w-xs text-sm text-fog">
                  Chat on the left. Preview on the right. Same workspace.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* How it works */}
        <section className="border-t border-line/60 bg-ink/30">
          <div className="mx-auto max-w-6xl px-6 py-20 md:px-10 md:py-28">
            <p className="animate-rise font-display text-sm font-semibold uppercase tracking-[0.2em] text-spark">
              How it works
            </p>
            <h2 className="animate-rise mt-4 max-w-2xl font-display text-3xl font-extrabold tracking-tight text-paper md:text-5xl">
              Prompt in. Preview out.
            </h2>
            <p className="animate-rise-delay mt-4 max-w-xl text-base text-fog md:text-lg">
              Three steps from idea to a running sandbox — no blank repo, no
              setup ceremony.
            </p>

            <ol className="mt-14 grid gap-10 md:grid-cols-3 md:gap-8">
              {[
                {
                  step: "01",
                  title: "Write the brief",
                  body: "Tell Lovable what to build in plain language. One prompt opens a project and starts the agent.",
                },
                {
                  step: "02",
                  title: "Watch the agent",
                  body: "Live status streams as files are created, wired into the app, and validated in your workspace.",
                },
                {
                  step: "03",
                  title: "Open the preview",
                  body: "A host-based preview URL renders the running app so you can iterate with follow-up prompts.",
                },
              ].map((item, i) => (
                <li
                  key={item.step}
                  className={`animate-rise${i === 0 ? "" : i === 1 ? "-delay" : "-late"} border-t border-line/70 pt-6`}
                >
                  <p className="font-display text-sm font-semibold text-spark">
                    {item.step}
                  </p>
                  <h3 className="mt-3 font-display text-xl font-bold text-paper">
                    {item.title}
                  </h3>
                  <p className="mt-3 text-sm leading-relaxed text-fog md:text-base">
                    {item.body}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Product moment */}
        <section className="border-t border-line/60">
          <div className="mx-auto grid max-w-6xl gap-12 px-6 py-20 md:grid-cols-2 md:items-center md:gap-16 md:px-10 md:py-28">
            <div className="animate-rise">
              <p className="font-display text-sm font-semibold uppercase tracking-[0.2em] text-spark">
                Studio
              </p>
              <h2 className="mt-4 font-display text-3xl font-extrabold tracking-tight text-paper md:text-5xl">
                A workspace built for the loop.
              </h2>
              <p className="mt-4 text-base leading-relaxed text-fog md:text-lg">
                Keep projects in a collapsible sidebar. Chat with the agent,
                run build and preview, and stay on one screen while the UI
                takes shape.
              </p>
            </div>
            <div className="animate-rise-delay space-y-4 border-l border-spark/40 pl-6 md:pl-10">
              {[
                "Projects list with show more — not an endless dump",
                "Live SSE status for every tool the agent runs",
                "Preview pane tied to your project’s ingress URL",
              ].map((line) => (
                <p key={line} className="text-base text-paper/90 md:text-lg">
                  <span className="mr-3 text-spark">→</span>
                  {line}
                </p>
              ))}
            </div>
          </div>
        </section>

        {/* Closing CTA */}
        <section className="border-t border-line/60 bg-gradient-to-b from-ink-soft/80 to-ink">
          <div className="mx-auto max-w-6xl px-6 py-20 text-center md:px-10 md:py-28">
            <h2 className="animate-rise font-display text-3xl font-extrabold tracking-tight text-paper md:text-5xl">
              Ready when you are.
            </h2>
            <p className="animate-rise-delay mx-auto mt-4 max-w-lg text-base text-fog md:text-lg">
              Open the studio, drop a prompt, and ship the first version before
              the coffee cools.
            </p>
            <div className="animate-rise-late mt-10 flex flex-wrap items-center justify-center gap-4">
              <Link
                to={primaryHref}
                className="rounded-full bg-spark px-7 py-3.5 font-semibold text-ink transition hover:bg-spark-deep"
              >
                {primaryLabel}
              </Link>
              {!isAuthenticated ? (
                <Link
                  to="/login"
                  className="rounded-full border border-line px-6 py-3.5 text-paper transition hover:border-spark hover:text-spark"
                >
                  Sign in
                </Link>
              ) : null}
            </div>
          </div>
        </section>

        <footer className="border-t border-line/60 px-6 py-8 md:px-10">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 text-sm text-fog">
            <BrandMark />
            <p>Prompt → agent → preview.</p>
          </div>
        </footer>
      </main>
    </div>
  );
}
