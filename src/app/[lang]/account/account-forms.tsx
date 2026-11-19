"use client";

import { useId, useState } from "react";
import type { Lang } from "@/modules/storefront/i18n";

// Customer accounts in the shop (ADR-0012): sign in, create an account, forgot password, set a new password and manage the
// account. Every request goes same-origin to the customer sign-in door (/api/customer-auth, allowlisted). Answers never say
// whether an address exists. Passwords stay in this page's memory only.

const T = {
  en: {
    signIn: "Sign in",
    create: "Create account",
    forgot: "Forgot password?",
    name: "Your name",
    email: "Email",
    password: "Password",
    newPassword: "New password",
    current: "Current password",
    again: "Password again",
    passwordHint: "At least 10 characters.",
    mismatch: "The two passwords are not the same.",
    wrong: "The email or password is not correct.",
    unverified: "Please confirm your email first: open the link we sent you.",
    resend: "Send the link again",
    resent: "If the address has an account, a new link is on its way.",
    created: "Almost done: we sent a link to your email. Open it to confirm your address, then you are signed in.",
    forgotSent: "If an account uses this address, we sent a link to set a new password. It works for one hour.",
    sendLink: "Send link",
    busy: "Please wait…",
    failed: "That did not work. Check your connection and try again.",
    limited: "Too many attempts. Wait a minute and try again.",
    resetDone: "Your password is changed. Sign in with the new one.",
    resetBad: "This link is not valid any more. Ask for a new one.",
    save: "Save",
    saved: "Saved.",
    changePassword: "Change password",
    passwordChanged: "Password changed. Other devices are signed out.",
    noPassword: "This account signs in with Google, so it has no password here.",
    back: "Back to sign in",
  },
  bn: {
    signIn: "সাইন ইন",
    create: "অ্যাকাউন্ট খুলুন",
    forgot: "পাসওয়ার্ড ভুলে গেছেন?",
    name: "আপনার নাম",
    email: "ইমেইল",
    password: "পাসওয়ার্ড",
    newPassword: "নতুন পাসওয়ার্ড",
    current: "বর্তমান পাসওয়ার্ড",
    again: "আবার পাসওয়ার্ড",
    passwordHint: "অন্তত ১০ অক্ষর।",
    mismatch: "দুটি পাসওয়ার্ড এক নয়।",
    wrong: "ইমেইল বা পাসওয়ার্ড সঠিক নয়।",
    unverified: "আগে আপনার ইমেইল নিশ্চিত করুন: আমাদের পাঠানো লিংকটি খুলুন।",
    resend: "লিংক আবার পাঠান",
    resent: "এই ঠিকানায় অ্যাকাউন্ট থাকলে নতুন লিংক যাচ্ছে।",
    created: "প্রায় শেষ: আপনার ইমেইলে একটি লিংক পাঠানো হয়েছে। লিংক খুলে ঠিকানা নিশ্চিত করলেই সাইন ইন হবে।",
    forgotSent: "এই ঠিকানায় অ্যাকাউন্ট থাকলে নতুন পাসওয়ার্ড দেওয়ার লিংক পাঠানো হয়েছে। লিংকটি এক ঘণ্টা কাজ করবে।",
    sendLink: "লিংক পাঠান",
    busy: "একটু অপেক্ষা করুন…",
    failed: "হয়নি। ইন্টারনেট সংযোগ দেখে আবার চেষ্টা করুন।",
    limited: "অনেকবার চেষ্টা হয়েছে। এক মিনিট পরে আবার চেষ্টা করুন।",
    resetDone: "পাসওয়ার্ড বদলেছে। নতুন পাসওয়ার্ড দিয়ে সাইন ইন করুন।",
    resetBad: "এই লিংকটি আর কাজ করে না। নতুন লিংক চান।",
    save: "সেভ করুন",
    saved: "সেভ হয়েছে।",
    changePassword: "পাসওয়ার্ড বদলান",
    passwordChanged: "পাসওয়ার্ড বদলেছে। অন্য ডিভাইস থেকে সাইন আউট হয়েছে।",
    noPassword: "এই অ্যাকাউন্ট Google দিয়ে সাইন ইন করে, তাই এখানে কোনো পাসওয়ার্ড নেই।",
    back: "সাইন ইনে ফিরে যান",
  },
} as const;

type Text = (typeof T)[Lang];

async function call(path: string, body: unknown): Promise<{ status: number; code?: string }> {
  const response = await fetch(`/api/customer-auth${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = (await response.json().catch(() => null)) as { code?: string } | null;
  return { status: response.status, code: data?.code };
}

function Input({ id, name, label, hint, ...rest }: { id: string; name: string; label: string; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <label htmlFor={`${id}-${name}`} className="sf-label">
        {label}
      </label>
      <input id={`${id}-${name}`} name={name} className="sf-field" aria-describedby={hint ? `${id}-${name}-hint` : undefined} {...rest} />
      {hint ? (
        <p id={`${id}-${name}-hint`} className="sf-hint mt-1.5">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function Note({ tone, children }: { tone?: "bad" | "ok"; children: React.ReactNode }) {
  return (
    <p role={tone === "bad" ? "alert" : "status"} className="sf-note font-semibold" data-tone={tone} data-testid="account-message">
      {children}
    </p>
  );
}

const failure = (t: Text, status: number) => (status === 429 ? t.limited : t.failed);

export function AccountForms({ lang }: { lang: Lang }) {
  const t = T[lang];
  const id = useId();
  const [mode, setMode] = useState<"in" | "up" | "forgot">("in");
  const [message, setMessage] = useState<{ tone?: "bad" | "ok"; text: string } | null>(null);
  const [unverified, setUnverified] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const callbackURL = `/${lang}/account?verified=1`;

  async function run(work: () => Promise<void>) {
    setPending(true);
    setMessage(null);
    try {
      await work();
    } catch {
      setMessage({ tone: "bad", text: t.failed });
    }
    setPending(false);
  }

  const signIn = (form: FormData) =>
    run(async () => {
      const email = String(form.get("email") ?? "");
      const r = await call("/sign-in/email", { email, password: form.get("password"), callbackURL: `/${lang}/account` });
      // A full reload, so every server-rendered part of the page sees the new session cookie.
      if (r.status === 200) return window.location.reload();
      if (r.status === 403 && r.code === "EMAIL_NOT_VERIFIED") {
        setUnverified(email);
        return setMessage({ tone: "bad", text: t.unverified });
      }
      setMessage({ tone: "bad", text: r.status === 401 ? t.wrong : failure(t, r.status) });
    });
  const signUp = (form: FormData) =>
    run(async () => {
      if (form.get("password") !== form.get("confirm")) return setMessage({ tone: "bad", text: t.mismatch });
      const r = await call("/sign-up/email", { name: form.get("name"), email: form.get("email"), password: form.get("password"), callbackURL });
      setMessage(r.status === 200 ? { tone: "ok", text: t.created } : { tone: "bad", text: failure(t, r.status) });
    });
  const forgot = (form: FormData) =>
    run(async () => {
      const r = await call("/request-password-reset", { email: form.get("email"), redirectTo: `/${lang}/account/reset` });
      setMessage(r.status === 200 ? { tone: "ok", text: t.forgotSent } : { tone: "bad", text: failure(t, r.status) });
    });
  const resend = () =>
    run(async () => {
      await call("/send-verification-email", { email: unverified, callbackURL });
      setMessage({ tone: "ok", text: t.resent });
    });

  const submit = (handler: (form: FormData) => void) => (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    handler(new FormData(event.currentTarget));
  };
  const tab = (m: typeof mode, label: string) => (
    <button type="button" aria-pressed={mode === m} onClick={() => (setMode(m), setMessage(null))} className={`sf-chip ${mode === m ? "border-sf-ink bg-sf-sun-soft" : ""}`}>
      {label}
    </button>
  );
  return (
    <div className="space-y-5" data-testid="account-forms">
      <div className="flex flex-wrap gap-2">
        {tab("in", t.signIn)}
        {tab("up", t.create)}
      </div>
      {mode === "in" ? (
        <form method="post" onSubmit={submit(signIn)} className="space-y-4">
          <Input id={id} name="email" label={t.email} type="email" autoComplete="email" required />
          <Input id={id} name="password" label={t.password} type="password" autoComplete="current-password" required maxLength={128} />
          <button type="submit" disabled={pending} className="sf-btn sf-btn-lg w-full">
            {pending ? t.busy : t.signIn}
          </button>
          <button type="button" className="sf-link inline-flex min-h-11 items-center" onClick={() => (setMode("forgot"), setMessage(null))}>
            {t.forgot}
          </button>
        </form>
      ) : mode === "up" ? (
        <form method="post" onSubmit={submit(signUp)} className="space-y-4">
          <Input id={id} name="name" label={t.name} autoComplete="name" required maxLength={100} />
          <Input id={id} name="email" label={t.email} type="email" autoComplete="email" required />
          <Input id={id} name="password" label={t.password} type="password" autoComplete="new-password" required minLength={10} maxLength={128} hint={t.passwordHint} />
          <Input id={id} name="confirm" label={t.again} type="password" autoComplete="new-password" required minLength={10} maxLength={128} />
          <button type="submit" disabled={pending} className="sf-btn sf-btn-lg w-full">
            {pending ? t.busy : t.create}
          </button>
        </form>
      ) : (
        <form method="post" onSubmit={submit(forgot)} className="space-y-4">
          <Input id={id} name="email" label={t.email} type="email" autoComplete="email" required />
          <button type="submit" disabled={pending} className="sf-btn sf-btn-lg w-full">
            {pending ? t.busy : t.sendLink}
          </button>
          <button type="button" className="sf-link inline-flex min-h-11 items-center" onClick={() => (setMode("in"), setMessage(null))}>
            {t.back}
          </button>
        </form>
      )}
      {message ? <Note tone={message.tone}>{message.text}</Note> : null}
      {unverified && mode === "in" ? (
        <button type="button" disabled={pending} onClick={resend} className="sf-btn sf-btn-ghost sf-btn-sm">
          {t.resend}
        </button>
      ) : null}
    </div>
  );
}

export function ResetPasswordForm({ lang, token }: { lang: Lang; token: string | null }) {
  const t = T[lang];
  const id = useId();
  const [state, setState] = useState<"form" | "done" | "bad">(token ? "form" : "bad");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (form.get("password") !== form.get("confirm")) return setMessage(t.mismatch);
    setPending(true);
    setMessage(null);
    const r = await call("/reset-password", { newPassword: form.get("password"), token }).catch(() => ({ status: 0 }));
    setPending(false);
    if (r.status === 200) setState("done");
    else if (r.status === 400) setState("bad");
    else setMessage(failure(t, r.status));
  }
  if (state === "done")
    return (
      <div className="space-y-4">
        <Note tone="ok">{t.resetDone}</Note>
        <a href={`/${lang}/account`} className="sf-btn sf-btn-lg w-full">
          {t.signIn}
        </a>
      </div>
    );
  if (state === "bad")
    return (
      <div className="space-y-4">
        <Note tone="bad">{t.resetBad}</Note>
        <a href={`/${lang}/account`} className="sf-btn sf-btn-ghost w-full">
          {t.back}
        </a>
      </div>
    );
  return (
    <form method="post" onSubmit={submit} className="space-y-4">
      <Input id={id} name="password" label={t.newPassword} type="password" autoComplete="new-password" required minLength={10} maxLength={128} hint={t.passwordHint} />
      <Input id={id} name="confirm" label={t.again} type="password" autoComplete="new-password" required minLength={10} maxLength={128} />
      {message ? <Note tone="bad">{message}</Note> : null}
      <button type="submit" disabled={pending} className="sf-btn sf-btn-lg w-full">
        {pending ? t.busy : t.save}
      </button>
    </form>
  );
}

export function ManageAccount({ lang, name, canChangePassword }: { lang: Lang; name: string; canChangePassword: boolean }) {
  const t = T[lang];
  const id = useId();
  const [message, setMessage] = useState<{ tone?: "bad" | "ok"; text: string } | null>(null);
  const [pending, setPending] = useState(false);
  async function rename(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    const r = await call("/update-user", { name: new FormData(event.currentTarget).get("name") }).catch(() => ({ status: 0 }));
    setPending(false);
    setMessage(r.status === 200 ? { tone: "ok", text: t.saved } : { tone: "bad", text: failure(t, r.status) });
  }
  async function change(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (form.get("password") !== form.get("confirm")) return setMessage({ tone: "bad", text: t.mismatch });
    setPending(true);
    const r = await call("/change-password", { currentPassword: form.get("current"), newPassword: form.get("password"), revokeOtherSessions: true }).catch(() => ({ status: 0 }));
    setPending(false);
    setMessage(r.status === 200 ? { tone: "ok", text: t.passwordChanged } : { tone: "bad", text: r.status === 400 || r.status === 401 ? t.wrong : failure(t, r.status) });
    if (r.status === 200) event.currentTarget.reset();
  }
  return (
    <div className="space-y-6">
      <form method="post" onSubmit={rename} className="space-y-3">
        <Input id={id} name="name" label={t.name} autoComplete="name" required maxLength={100} defaultValue={name} />
        <button type="submit" disabled={pending} className="sf-btn sf-btn-ghost sf-btn-sm">
          {t.save}
        </button>
      </form>
      {canChangePassword ? (
        <form method="post" onSubmit={change} className="space-y-3">
          <h3 className="sf-plain">{t.changePassword}</h3>
          <Input id={id} name="current" label={t.current} type="password" autoComplete="current-password" required maxLength={128} />
          <Input id={id} name="password" label={t.newPassword} type="password" autoComplete="new-password" required minLength={10} maxLength={128} hint={t.passwordHint} />
          <Input id={id} name="confirm" label={t.again} type="password" autoComplete="new-password" required minLength={10} maxLength={128} />
          <button type="submit" disabled={pending} className="sf-btn sf-btn-ghost sf-btn-sm">
            {t.changePassword}
          </button>
        </form>
      ) : (
        <p className="sf-hint">{t.noPassword}</p>
      )}
      {message ? <Note tone={message.tone}>{message.text}</Note> : null}
    </div>
  );
}
