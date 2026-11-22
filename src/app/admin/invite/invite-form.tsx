"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { type LinkAnswer, redeemLinkAction, staffLinkAction } from "../staff/actions";

// A staff invitation or set-password link (src/modules/auth/staff.ts). The token is read from the URL fragment (#t=…), which
// browsers never send to a server; right after reading it the page removes it from the address bar and history and keeps it
// in memory only. It reaches the server only in a same-origin Server Action body. Reloading needs the link again.

const input = "of-input mt-1.5";

function takeToken(): string | null {
  const token = new URLSearchParams(window.location.hash.slice(1)).get("t");
  if (window.location.hash) window.history.replaceState(null, "", window.location.pathname);
  return token;
}

export function InviteForm() {
  const id = useId();
  const token = useRef<string | null>(null);
  const [link, setLink] = useState<LinkAnswer | { ok: "loading" } | { ok: "none" }>({ ok: "loading" });
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<"invite" | "password" | null>(null);

  useEffect(() => {
    // The ref keeps a token already taken when the effect runs again (React's development double run).
    token.current = takeToken() ?? token.current;
    if (!token.current) {
      setLink({ ok: "none" });
      return;
    }
    staffLinkAction(token.current)
      .then(setLink)
      .catch(() => setLink({ ok: false, error: "The server could not be reached. Open the link again." }));
  }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (form.get("password") !== form.get("confirm")) return setError("The two passwords are not the same.");
    setPending(true);
    setError(null);
    const answer = await redeemLinkAction({ token: token.current ?? "", name: String(form.get("name") ?? ""), password: String(form.get("password") ?? "") }).catch(() => ({
      ok: false as const,
      error: "The server could not be reached. Try again.",
    }));
    setPending(false);
    if (!answer.ok) return setError(answer.error);
    setDone(answer.kind);
  }

  if (done) {
    return (
      <div className="space-y-4" data-testid="invite-done">
        <p className="font-semibold text-green-800">{done === "invite" ? "Your account is ready." : "Your new password is set and your old sessions have ended."}</p>
        <Link href="/admin/login" className="of-btn of-btn-primary w-full">
          Sign in
        </Link>
      </div>
    );
  }
  if (link.ok === "loading") return <p role="status">Checking the link…</p>;
  if (link.ok === "none") return <p role="alert">Open the link from your invitation to continue. For your privacy the link is removed from the address bar once it is opened.</p>;
  if (!link.ok) {
    return (
      <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-800" data-testid="invite-error">
        {link.error}
      </p>
    );
  }
  return (
    <form method="post" onSubmit={submit} className="space-y-4" data-testid="invite-form">
      <p className="text-sm text-gray-700">
        {link.kind === "invite" ? (
          <>
            You are joining as <strong>{link.roleLabel}</strong> with <strong className="break-all">{link.email}</strong>. You will sign in with this email and the password you choose here.
          </>
        ) : (
          <>
            Choose a new password for <strong className="break-all">{link.email}</strong>.
          </>
        )}
      </p>
      {link.kind === "invite" ? (
        <div>
          <label htmlFor={`${id}-name`} className="block text-sm font-semibold">
            Your name
          </label>
          <input id={`${id}-name`} name="name" className={input} autoComplete="name" required maxLength={100} />
        </div>
      ) : null}
      {/* A hidden username field lets a password manager save the new password with the right account. */}
      <input type="email" name="username" value={link.email} autoComplete="username" readOnly hidden />
      <div>
        <label htmlFor={`${id}-password`} className="block text-sm font-semibold">
          {link.kind === "invite" ? "Password" : "New password"}
        </label>
        <input id={`${id}-password`} name="password" type="password" className={input} autoComplete="new-password" required minLength={15} maxLength={128} aria-describedby={`${id}-hint`} />
        <p id={`${id}-hint`} className="mt-1 text-xs text-gray-600">
          At least 15 characters. A few unrelated words work well. Do not reuse a password from elsewhere.
        </p>
      </div>
      <div>
        <label htmlFor={`${id}-confirm`} className="block text-sm font-semibold">
          {link.kind === "invite" ? "Password again" : "New password again"}
        </label>
        <input id={`${id}-confirm`} name="confirm" type="password" className={input} autoComplete="new-password" required minLength={15} maxLength={128} />
      </div>
      {error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">
          {error}
        </p>
      ) : null}
      <button type="submit" disabled={pending} className="of-btn of-btn-primary w-full">
        {pending ? "Saving…" : link.kind === "invite" ? "Create my account" : "Set new password"}
      </button>
    </form>
  );
}
