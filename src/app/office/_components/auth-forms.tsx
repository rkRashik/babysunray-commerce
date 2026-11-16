"use client";

import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore } from "react";

// Sign-in and sign-out go through Better Auth's own HTTP endpoints (/api/auth), so its origin check and
// its PostgreSQL sign-in rate limit apply, and the session arrives as an HttpOnly cookie. The response
// body is never read: no token is ever handled by page scripts (the Bearer header is removed for browsers).

const noSubscription = () => () => {};

export function SignInForm() {
  const router = useRouter();
  // False in the server HTML, true once React runs here. Until then the button stays disabled, so a press of Enter or a
  // click before the script is ready cannot submit the form natively (which would put the password in the URL).
  const ready = useSyncExternalStore(noSubscription, () => true, () => false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
      });
      if (response.ok) {
        router.replace("/office");
        router.refresh();
        return;
      }
      setError(response.status === 429 ? "Too many attempts. Wait a few seconds and try again." : "The email or password is not correct.");
    } catch {
      setError("The server could not be reached. Try again.");
    }
    setPending(false);
  }

  const input = "mt-1 block w-full rounded border border-gray-400 px-3 py-2 text-base focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900";
  return (
    // method="post" as a second guard: even a native submission never carries the password in a URL.
    <form method="post" onSubmit={onSubmit} className="space-y-4">
      <div>
        <label htmlFor="email" className="block text-sm font-medium">
          Email
        </label>
        <input id="email" name="email" type="email" autoComplete="username" required className={input} />
      </div>
      <div>
        <label htmlFor="password" className="block text-sm font-medium">
          Password
        </label>
        <input id="password" name="password" type="password" autoComplete="current-password" required minLength={15} maxLength={128} className={input} />
      </div>
      {error ? (
        <p role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          {error}
        </p>
      ) : null}
      <button type="submit" disabled={!ready || pending} className="w-full rounded bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-60">
        {pending ? "Signing in…" : "Sign in"}
      </button>
      <noscript>
        <p className="text-sm text-gray-700">Signing in needs JavaScript.</p>
      </noscript>
    </form>
  );
}

export function SignOutButton() {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  async function signOut() {
    setPending(true);
    try {
      // Better Auth accepts POST bodies only as JSON (415 otherwise), even when it ignores the body.
      await fetch("/api/auth/sign-out", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    } finally {
      router.replace("/office/login");
      router.refresh();
    }
  }
  return (
    <button type="button" onClick={signOut} disabled={pending} className="rounded border border-gray-400 px-3 py-1 text-sm hover:bg-gray-100 disabled:opacity-60">
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}
