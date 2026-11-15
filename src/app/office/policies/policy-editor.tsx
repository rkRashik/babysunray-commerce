"use client";

import { unstable_rethrow } from "next/navigation";
import { useActionState, useEffect, useId, useState } from "react";
import { useFormStatus } from "react-dom";
import type { FormState } from "../_lib/form";
import { savePolicyAction } from "./actions";

// The editor of one policy draft: English and Bangla side by side, plain text only. It says plainly when there are
// unsaved changes and asks before the page is left with them. The version it was opened at goes with every save,
// so a stale tab can never overwrite a newer draft (VERSION_CONFLICT). The server renders the idempotency key.

const LOST = "The server could not be reached, so nothing was saved. Press Save again: if the first attempt was saved, it is not saved twice.";
const AREA = "mt-1 block w-full rounded border border-gray-400 bg-white px-3 py-2 text-base leading-relaxed focus:border-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-900";

type Props = { kind: string; title: string; version: number; bodyEn: string; bodyBn: string; idempotencyKey: string };

export function PolicyEditor({ kind, title, version, bodyEn, bodyBn, idempotencyKey }: Props) {
  const [state, action] = useActionState(async (previous: FormState, form: FormData): Promise<FormState> => {
    try {
      return await savePolicyAction(previous, form);
    } catch (error) {
      unstable_rethrow(error);
      if (error instanceof TypeError) return { error: LOST };
      throw error;
    }
  }, {});
  const [en, setEn] = useState(bodyEn);
  const [bn, setBn] = useState(bodyBn);
  // The text areas are controlled, so what was typed stays after an error (React resets only uncontrolled fields).
  const dirty = en !== bodyEn || bn !== bodyBn;
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const id = useId();
  return (
    <form action={action} className="space-y-3" aria-describedby={state.error ? `${id}-error` : undefined} data-testid={`policy-editor-${kind}`}>
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="version" value={version} />
      <Fields>
        <div className="grid gap-4 md:grid-cols-2">
          <div>
            <label htmlFor={`${id}-en`} className="block text-sm font-medium">
              {title}: English text
            </label>
            <textarea id={`${id}-en`} name="bodyEn" rows={12} maxLength={20_000} value={en} onChange={(e) => setEn(e.target.value)} className={AREA} />
          </div>
          <div>
            <label htmlFor={`${id}-bn`} className="block text-sm font-medium">
              {title}: Bangla text
            </label>
            <textarea id={`${id}-bn`} name="bodyBn" lang="bn" rows={12} maxLength={20_000} value={bn} onChange={(e) => setBn(e.target.value)} className={AREA} />
          </div>
        </div>
      </Fields>
      <p role="status" aria-live="polite" className={`text-sm ${dirty ? "font-semibold text-amber-900" : "text-gray-700"}`} data-testid={`policy-state-${kind}`}>
        {dirty ? "Unsaved changes." : version === 0 ? "Nothing saved yet." : `Saved as version ${version}.`}
      </p>
      {state.error ? (
        <p id={`${id}-error`} role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          {state.error}
        </p>
      ) : null}
      <Save dirty={dirty} />
    </form>
  );
}

function Fields({ children }: { children: React.ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <fieldset disabled={pending} className="disabled:opacity-80">
      {children}
    </fieldset>
  );
}

function Save({ dirty }: { dirty: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || !dirty}
      className="rounded bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2 disabled:opacity-60"
    >
      {pending ? "Saving…" : "Save draft"}
    </button>
  );
}

/** Copies both languages as plain text, for sending to a reviewer. Nothing leaves the browser otherwise. */
export function CopyText({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={async () => {
          await navigator.clipboard.writeText(text);
          setCopied(true);
        }}
        className="rounded border border-gray-400 bg-white px-3 py-1.5 text-sm font-medium hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900"
      >
        {label}
      </button>
      <span role="status" className="text-sm text-gray-700">
        {copied ? "Copied." : ""}
      </span>
    </span>
  );
}
