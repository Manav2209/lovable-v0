import { Link } from "react-router-dom";
import { useAuth } from "@/lib/auth";

export function BrandMark({ large = false }: { large?: boolean }) {
  return (
    <Link
      to="/"
      className={`font-display font-extrabold tracking-tight text-paper ${
        large ? "text-5xl md:text-7xl" : "text-xl"
      }`}
    >
      Lovable
      <span className="text-spark">.</span>
    </Link>
  );
}

export function TopBar() {
  const { user, logout } = useAuth();

  return (
    <header className="flex items-center justify-between border-b border-line/70 px-5 py-4 md:px-8">
      <BrandMark />
      <div className="flex items-center gap-4 text-sm text-fog">
        {user ? (
          <>
            <Link to="/studio" className="hidden transition hover:text-spark sm:inline">
              Studio
            </Link>
            <span className="hidden sm:inline">{user.username}</span>
          </>
        ) : null}
        <button
          type="button"
          onClick={logout}
          className="rounded-full border border-line px-3 py-1.5 text-paper transition hover:border-spark hover:text-spark"
        >
          Log out
        </button>
      </div>
    </header>
  );
}
