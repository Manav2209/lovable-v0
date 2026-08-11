import { type FormEvent, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { BrandMark } from "@/components/Brand";
import { useAuth } from "@/lib/auth";

export function SignupPage() {
  const { signup, isAuthenticated } = useAuth();
  const navigate = useNavigate();

  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (isAuthenticated) return <Navigate to="/studio" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await signup(username, email, password);
      navigate("/studio", { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Signup failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6 py-12">
      <div className="animate-rise mb-10">
        <BrandMark large />
        <p className="mt-4 text-fog">Create an account and ship the first draft.</p>
      </div>

      <form onSubmit={onSubmit} className="animate-rise-delay space-y-4">
        <label className="block space-y-2">
          <span className="text-sm text-fog">Username</span>
          <input
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="w-full rounded-xl border border-line bg-ink-soft px-4 py-3 outline-none ring-spark/40 focus:ring-2"
          />
        </label>
        <label className="block space-y-2">
          <span className="text-sm text-fog">Email</span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-xl border border-line bg-ink-soft px-4 py-3 outline-none ring-spark/40 focus:ring-2"
          />
        </label>
        <label className="block space-y-2">
          <span className="text-sm text-fog">Password</span>
          <input
            type="password"
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-xl border border-line bg-ink-soft px-4 py-3 outline-none ring-spark/40 focus:ring-2"
          />
        </label>

        {error ? (
          <p className="rounded-lg border border-ember/40 bg-ember/10 px-3 py-2 text-sm text-ember">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-full bg-spark px-5 py-3 font-semibold text-ink transition hover:bg-spark-deep disabled:opacity-60"
        >
          {loading ? "Creating…" : "Create account"}
        </button>
      </form>

      <p className="mt-6 text-sm text-fog">
        Already have an account?{" "}
        <Link to="/login" className="text-spark underline-offset-2 hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
