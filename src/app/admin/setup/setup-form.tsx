"use client";

import { Check, Copy, Download, KeyRound, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { completeSetupAction, recoverOwnerAction, startSetupAction } from "./actions";

// The first-time setup steps in the browser. The setup code and the password stay in this page's memory only (never in the
// URL or browser storage); the recovery codes are shown once, to save or print.

const input = "of-input mt-1.5";
const label = "block text-sm font-semibold";

function Field({ id, name, text, hint, ...rest }: { id: string; name: string; text: string; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <label htmlFor={`${id}-${name}`} className={label}>
        {text}
      </label>
      <input id={`${id}-${name}`} name={name} className={input} aria-describedby={hint ? `${id}-${name}-hint` : undefined} {...rest} />
      {hint ? (
        <p id={`${id}-${name}-hint`} className="mt-1 text-xs text-gray-600">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function SetupForm({ emailOn }: { emailOn: boolean }) {
  const id = useId();
  const [step, setStep] = useState<"grant" | "account" | "codes">("grant");
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [codes, setCodes] = useState<string[]>([]);
  const [verified, setVerified] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function begin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const answer = await startSetupAction({ token, email }).catch(() => ({ ok: false as const, error: "The server could not be reached. Try again." }));
    setPending(false);
    if (!answer.ok) return setError(answer.error);
    setCodeSent(Boolean(answer.codeSent));
    setStep("account");
  }

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (form.get("password") !== form.get("confirm")) return setError("The two passwords are not the same.");
    setPending(true);
    setError(null);
    const answer = await completeSetupAction({ token, email, name: String(form.get("name") ?? ""), password: String(form.get("password") ?? ""), code: String(form.get("code") ?? "") }).catch(() => ({
      ok: false as const,
      error: "The server could not be reached. Nothing may have been created yet: try again.",
    }));
    setPending(false);
    if (!answer.ok) return setError(answer.error);
    setToken("");
    setCodes(answer.recoveryCodes ?? []);
    setVerified(Boolean(answer.emailVerified));
    setStep("codes");
  }

  const errorBox = error ? (
    <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-800" data-testid="setup-error">
      {error}
    </p>
  ) : null;

  if (step === "codes") {
    const text = `Admin recovery codes (each works once)\n\n${codes.join("\n")}\n`;
    return (
      <div className="space-y-5" data-testid="setup-done">
        <p className="flex items-center gap-2 font-semibold text-green-800">
          <Check aria-hidden="true" size={20} /> Owner account created.
        </p>
        {!verified ? <p className="rounded-xl bg-amber-50 px-4 py-3 text-sm">Email is not set up on this server, so your address is not verified yet. Everything works; add email later in the settings.</p> : null}
        <div className="space-y-2">
          <p className="flex items-center gap-2 text-sm font-semibold">
            <KeyRound aria-hidden="true" size={18} /> Recovery codes · রিকভারি কোড
          </p>
          <p className="text-sm text-gray-700">If you ever lose your password, one of these codes lets you set a new one. Each works once. They are shown only now: save or print them and keep them somewhere safe.</p>
          <ol className="grid grid-cols-1 gap-1 rounded-xl bg-gray-50 p-4 font-mono text-sm sm:grid-cols-2" data-testid="recovery-codes">
            {codes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ol>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="of-btn of-btn-line gap-2" onClick={() => void navigator.clipboard.writeText(text)}>
              <Copy aria-hidden="true" size={16} /> Copy
            </button>
            <a className="of-btn of-btn-line gap-2" href={`data:text/plain;charset=utf-8,${encodeURIComponent(text)}`} download="admin-recovery-codes.txt">
              <Download aria-hidden="true" size={16} /> Download
            </a>
          </div>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1 h-5 w-5" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          I saved my recovery codes.
        </label>
        {saved ? (
          <Link href="/admin/login" className="of-btn of-btn-primary w-full">
            Continue to sign in
          </Link>
        ) : null}
      </div>
    );
  }

  if (step === "account") {
    return (
      <form method="post" onSubmit={create} className="space-y-4">
        <p className="text-sm text-gray-700">
          Owner email: <strong>{email}</strong>
        </p>
        {codeSent ? <Field id={id} name="code" text="Code from your email · ইমেইলের কোড" inputMode="numeric" autoComplete="one-time-code" required maxLength={6} hint="We sent a 6-digit code to this address. It works for 15 minutes." /> : null}
        <Field id={id} name="name" text="Your name · আপনার নাম" autoComplete="name" required maxLength={100} />
        <Field id={id} name="password" text="Password · পাসওয়ার্ড" type="password" autoComplete="new-password" required minLength={15} maxLength={128} hint="At least 15 characters. A short sentence is easy to remember and strong." />
        <Field id={id} name="confirm" text="Password again" type="password" autoComplete="new-password" required minLength={15} maxLength={128} />
        {errorBox}
        <button type="submit" disabled={pending} className="of-btn of-btn-primary w-full">
          {pending ? "Creating…" : "Create Owner account"}
        </button>
        <button type="button" className="of-btn of-btn-line w-full" onClick={() => setStep("grant")}>
          Back
        </button>
      </form>
    );
  }

  return (
    <form method="post" onSubmit={begin} className="space-y-4">
      <Field
        id={id}
        name="token"
        text="Setup code · সেটআপ কোড"
        type="password"
        autoComplete="off"
        required
        value={token}
        onChange={(e) => setToken(e.target.value)}
        hint="The value you set as ADMIN_SETUP_TOKEN in the site's settings."
      />
      <Field id={id} name="email" text="Owner email · ইমেইল" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      {!emailOn ? <p className="text-xs text-gray-600">Email is not set up on this server: your address cannot be verified now (you can add email later).</p> : null}
      {errorBox}
      <button type="submit" disabled={pending} className="of-btn of-btn-primary w-full gap-2">
        <ShieldCheck aria-hidden="true" size={18} />
        {pending ? "Checking…" : "Continue"}
      </button>
    </form>
  );
}

export function RecoverForm() {
  const id = useId();
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (form.get("password") !== form.get("confirm")) return setError("The two passwords are not the same.");
    setPending(true);
    setError(null);
    const answer = await recoverOwnerAction({ email: String(form.get("email") ?? ""), code: String(form.get("code") ?? ""), password: String(form.get("password") ?? "") }).catch(() => ({
      ok: false as const,
      error: "The server could not be reached. Try again.",
    }));
    setPending(false);
    if (!answer.ok) return setError(answer.error);
    setDone(true);
  }
  if (done) {
    return (
      <div className="space-y-4" data-testid="recover-done">
        <p className="font-semibold text-green-800">Your password is changed and every old session has ended.</p>
        <Link href="/admin/login" className="of-btn of-btn-primary w-full">
          Sign in
        </Link>
      </div>
    );
  }
  return (
    <form method="post" onSubmit={submit} className="space-y-4">
      <Field id={id} name="email" text="Owner email" type="email" autoComplete="username" required />
      <Field id={id} name="code" text="Recovery code" autoComplete="off" required maxLength={40} hint="One of the codes you saved at setup, for example 1A2B3-C4D5E-…" />
      <Field id={id} name="password" text="New password" type="password" autoComplete="new-password" required minLength={15} maxLength={128} />
      <Field id={id} name="confirm" text="New password again" type="password" autoComplete="new-password" required minLength={15} maxLength={128} />
      {error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">
          {error}
        </p>
      ) : null}
      <button type="submit" disabled={pending} className="of-btn of-btn-primary w-full">
        {pending ? "Saving…" : "Set new password"}
      </button>
    </form>
  );
}
