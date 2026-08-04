import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Link, useParams } from "react-router-dom";
import { TopBar } from "@/components/Brand";
import {
  api,
  type ConversationMessage,
  type ProjectDetail,
} from "@/lib/api";

type AgentEvent = {
  type: string;
  message?: string;
  toolName?: string;
  error?: string;
};

function toSseConnectUrl(sseUrl: string, projectId: string): string {
  try {
    const url = new URL(sseUrl, window.location.origin);
    if (!url.searchParams.get("id")) {
      url.searchParams.set("id", projectId);
    }
    return url.toString();
  } catch {
    return sseUrl.includes("?")
      ? `${sseUrl}&id=${projectId}`
      : `${sseUrl}?id=${projectId}`;
  }
}

export function WorkspacePage() {
  const { projectId = "" } = useParams();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [prompt, setPrompt] = useState("");
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [iframeKey, setIframeKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [running, setRunning] = useState(false);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const loadProject = useCallback(async () => {
    if (!projectId) return;
    const res = await api.getProject(projectId);
    setProject(res.data);
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await loadProject();
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load project");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      esRef.current?.close();
    };
  }, [loadProject]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [project?.conversationHistory, events]);

  function attachSse(sseUrl: string) {
    esRef.current?.close();
    const connectUrl = toSseConnectUrl(sseUrl, projectId);
    const es = new EventSource(connectUrl);
    esRef.current = es;

    es.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data) as AgentEvent;
        setEvents((prev) => [...prev, data]);
        if (data.type === "completed" || data.type === "error") {
          es.close();
          void loadProject();
        }
      } catch {
        setEvents((prev) => [
          ...prev,
          { type: "raw", message: msg.data },
        ]);
      }
    };

    es.onerror = () => {
      setEvents((prev) => [
        ...prev,
        {
          type: "sse_error",
          message:
            "SSE connection failed (preview/agent stream may need port-forward or ingress).",
        },
      ]);
      es.close();
    };
  }

  async function onSend(e: FormEvent) {
    e.preventDefault();
    if (!projectId || !prompt.trim()) return;
    setSending(true);
    setError(null);
    const text = prompt.trim();
    setPrompt("");
    setEvents([]);

    const optimistic: ConversationMessage = {
      id: `temp-${Date.now()}`,
      projectId,
      type: "TEXT_MESSAGE",
      from: "USER",
      contents: text,
      hidden: false,
      toolCall: null,
      createdAt: new Date().toISOString(),
    };
    setProject((prev) =>
      prev
        ? {
            ...prev,
            conversationHistory: [...prev.conversationHistory, optimistic],
          }
        : prev,
    );

    try {
      const res = await api.sendPrompt(projectId, text);
      const sseUrl = res.data?.sseUrl;
      if (sseUrl) attachSse(sseUrl);
      await loadProject();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send prompt");
    } finally {
      setSending(false);
    }
  }

  async function onRun() {
    if (!projectId) return;
    setRunning(true);
    setError(null);
    try {
      const res = await api.runProject(projectId);
      setPreviewUrl(res.data?.url || null);
      setIframeKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Run failed");
    } finally {
      setRunning(false);
    }
  }

  async function onBuild() {
    if (!projectId) return;
    setBuilding(true);
    setError(null);
    try {
      await api.buildProject(projectId);
      setEvents((prev) => [
        ...prev,
        { type: "build", message: "Build completed" },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Build failed");
    } finally {
      setBuilding(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen">
        <TopBar />
        <p className="px-8 py-16 text-fog">Loading workspace…</p>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="min-h-screen">
        <TopBar />
        <div className="px-8 py-16">
          <p className="text-ember">{error || "Project not found"}</p>
          <Link to="/" className="mt-4 inline-block text-spark">
            ← Back home
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col">
      <TopBar />

      <div className="flex flex-1 flex-col lg:flex-row lg:overflow-hidden lg:h-[calc(100vh-65px)]">
        {/* Chat column */}
        <section className="flex w-full flex-col border-b border-line/70 lg:w-[42%] lg:border-b-0 lg:border-r">
          <div className="border-b border-line/70 px-5 py-4">
            <Link to="/" className="text-sm text-fog hover:text-spark">
              ← Projects
            </Link>
            <h1 className="mt-2 font-display text-xl font-bold text-paper">
              {project.title}
            </h1>
            <p className="mt-1 line-clamp-2 text-sm text-fog">
              {project.initialPrompt}
            </p>
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
            {project.conversationHistory
              .filter((m) => !m.hidden)
              .map((m) => (
                <div
                  key={m.id}
                  className={`max-w-[95%] rounded-2xl px-4 py-3 text-sm leading-relaxed ${
                    m.from === "USER"
                      ? "ml-auto bg-spark/15 text-paper"
                      : "bg-panel text-fog"
                  }`}
                >
                  <p className="mb-1 text-[11px] uppercase tracking-wide opacity-60">
                    {m.from === "USER" ? "You" : "Agent"}
                  </p>
                  <p className="whitespace-pre-wrap text-paper/95">{m.contents}</p>
                </div>
              ))}

            {events.length > 0 ? (
              <div className="rounded-2xl border border-line/80 bg-ink/50 px-4 py-3">
                <p className="mb-2 text-[11px] uppercase tracking-wide text-spark">
                  Live status
                </p>
                <ul className="space-y-1.5 text-sm text-fog">
                  {events.map((ev, i) => (
                    <li key={`${ev.type}-${i}`}>
                      <span className="text-paper/80">{ev.type}</span>
                      {ev.message ? ` — ${ev.message}` : ""}
                      {ev.toolName ? ` (${ev.toolName})` : ""}
                      {ev.error ? ` · ${ev.error}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div ref={chatEndRef} />
          </div>

          <form
            onSubmit={onSend}
            className="border-t border-line/70 bg-ink-soft/80 p-4"
          >
            {error ? (
              <p className="mb-3 rounded-lg border border-ember/40 bg-ember/10 px-3 py-2 text-sm text-ember">
                {error}
              </p>
            ) : null}
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
              placeholder="Ask for a change…"
              className="w-full resize-none rounded-xl border border-line bg-ink px-4 py-3 text-sm outline-none ring-spark/30 focus:ring-2"
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="submit"
                disabled={sending || !prompt.trim()}
                className="rounded-full bg-spark px-5 py-2.5 text-sm font-semibold text-ink disabled:opacity-50"
              >
                {sending ? "Sending…" : "Send"}
              </button>
              <button
                type="button"
                onClick={onBuild}
                disabled={building}
                className="rounded-full border border-line px-4 py-2.5 text-sm text-paper hover:border-spark disabled:opacity-50"
              >
                {building ? "Building…" : "Build"}
              </button>
              <button
                type="button"
                onClick={onRun}
                disabled={running}
                className="rounded-full border border-line px-4 py-2.5 text-sm text-paper hover:border-spark disabled:opacity-50"
              >
                {running ? "Starting…" : "Run preview"}
              </button>
            </div>
          </form>
        </section>

        {/* Preview column */}
        <section className="flex min-h-[40vh] flex-1 flex-col bg-ink/40 lg:min-h-0">
          <div className="flex items-center justify-between gap-3 border-b border-line/70 px-5 py-3">
            <p className="font-display text-sm font-semibold text-paper">
              Preview
            </p>
            <div className="flex items-center gap-2">
              {previewUrl ? (
                <a
                  href={previewUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="truncate text-xs text-spark hover:underline"
                >
                  {previewUrl}
                </a>
              ) : (
                <span className="text-xs text-fog">No live URL yet</span>
              )}
              <button
                type="button"
                onClick={() => setIframeKey((k) => k + 1)}
                disabled={!previewUrl}
                className="rounded-full border border-line px-3 py-1 text-xs text-fog hover:text-paper disabled:opacity-40"
                title="Reload iframe"
              >
                Refresh
              </button>
            </div>
          </div>

          <div className="relative flex-1 bg-[radial-gradient(circle_at_center,rgba(198,240,77,0.05),transparent_55%)]">
            {previewUrl ? (
              <iframe
                key={iframeKey}
                title="Project preview"
                src={previewUrl}
                className="absolute inset-0 h-full w-full border-0 bg-white"
              />
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
                <p className="font-display text-2xl font-bold text-paper/90">
                  Preview waits for Run
                </p>
                <p className="max-w-sm text-sm text-fog">
                  After the agent finishes, hit Run preview. The iframe loads
                  the host-based ingress URL when available.
                </p>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
