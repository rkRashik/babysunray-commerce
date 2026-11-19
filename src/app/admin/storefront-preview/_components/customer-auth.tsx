"use client";

import { LogOut } from "lucide-react";
import { useState } from "react";
import { dictionary, type Lang } from "@/modules/storefront/i18n";

// Optional customer sign-in (shop only; ADR-0011): "Continue with Google" and "Sign out", both same-origin POSTs to the
// customer instance (/api/customer-auth). Google's page is reached only through the URL the server returns; the browser
// never sees a client secret or token. After Google, the customer returns to `returnTo` (a path on this site only).

const SAFE_PATH = /^\/(en|bn)(\/[a-z0-9/-]*)?$/;

export function GoogleSignInButton({ lang, returnTo, className = "" }: { lang: Lang; returnTo: string; className?: string }) {
  const t = dictionary(lang);
  const [state, setState] = useState<"idle" | "busy" | "failed">("idle");
  async function start() {
    setState("busy");
    try {
      const back = SAFE_PATH.test(returnTo) ? returnTo : `/${lang}`;
      const response = await fetch("/api/customer-auth/sign-in/social", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "google", callbackURL: back, errorCallbackURL: `/${lang}/order?signin=failed`, disableRedirect: true }),
      });
      const body = (await response.json().catch(() => null)) as { url?: unknown } | null;
      if (!response.ok || typeof body?.url !== "string" || !body.url.startsWith("https://accounts.google.com/")) throw new Error("no url");
      window.location.assign(body.url);
    } catch {
      setState("failed");
    }
  }
  return (
    <div className="space-y-2">
      <button type="button" onClick={start} disabled={state === "busy"} className={`sf-btn sf-btn-ghost gap-2.5 ${className}`} data-testid="google-sign-in">
        <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20">
          <path fill="#4285F4" d="M22.6 12.2c0-.8-.1-1.5-.2-2.2H12v4.2h5.9a5 5 0 0 1-2.2 3.3v2.7h3.6c2.1-1.9 3.3-4.8 3.3-8z" />
          <path fill="#34A853" d="M12 23c3 0 5.5-1 7.3-2.7l-3.6-2.7c-1 .7-2.2 1.1-3.7 1.1-2.9 0-5.3-1.9-6.2-4.5H2.1v2.8A11 11 0 0 0 12 23z" />
          <path fill="#FBBC05" d="M5.8 14.2a6.6 6.6 0 0 1 0-4.3V7.1H2.1a11 11 0 0 0 0 9.9l3.7-2.8z" />
          <path fill="#EA4335" d="M12 5.4c1.6 0 3.1.6 4.2 1.7l3.2-3.2A11 11 0 0 0 2.1 7.1l3.7 2.8C6.7 7.3 9.1 5.4 12 5.4z" />
        </svg>
        {state === "busy" ? t.signingIn : t.signInGoogle}
      </button>
      {state === "failed" ? (
        <p role="alert" className="sf-note font-semibold" data-tone="bad">
          {t.signInUnavailable}
        </p>
      ) : null}
    </div>
  );
}

export function CustomerSignOutButton({ lang }: { lang: Lang }) {
  const t = dictionary(lang);
  const [busy, setBusy] = useState(false);
  async function signOut() {
    setBusy(true);
    try {
      await fetch("/api/customer-auth/sign-out", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    } finally {
      window.location.reload();
    }
  }
  return (
    <button type="button" onClick={signOut} disabled={busy} className="sf-btn sf-btn-ghost sf-btn-sm gap-2" data-testid="customer-sign-out">
      <LogOut aria-hidden="true" size={18} strokeWidth={1.75} />
      {t.signOut}
    </button>
  );
}
