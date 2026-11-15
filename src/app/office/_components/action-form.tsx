"use client";

import { unstable_rethrow } from "next/navigation";
import { createContext, useActionState, useContext, useId } from "react";
import { useFormStatus } from "react-dom";
import type { FormState } from "../actions";

// A form bound to an Office Server Action. The server renders the idempotency key; the button is disabled
// while the action runs, and the same key is sent again on any resubmission, so an entry is made once.

const Values = createContext<Record<string, string>>({});

/** What was typed, so the form can show it again (React resets the fields after every submission). */
function typedValues(form: FormData): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [name, value] of form) if (typeof value === "string" && /^[a-zA-Z]+$/.test(name) && name !== "idempotencyKey") values[name] = value;
  return values;
}

const LOST =
  "The server could not be reached, so there was no answer. Press the button again: if the first attempt was saved, it is not saved twice.";

type Props = {
  action: (state: FormState, form: FormData) => Promise<FormState>;
  idempotencyKey: string;
  hidden?: Record<string, string>;
  submitLabel: string;
  children?: React.ReactNode;
  variant?: "primary" | "secondary";
};

export function ActionForm({ action, idempotencyKey, hidden = {}, submitLabel, children, variant = "primary" }: Props) {
  const [state, formAction] = useActionState(async (previous: FormState, form: FormData): Promise<FormState> => {
    try {
      return await action(previous, form);
    } catch (error) {
      // A redirect (success, or an expired session) and other Next.js signals pass through.
      unstable_rethrow(error);
      // fetch() failing: the connection dropped. The same key is resent with the next press.
      if (error instanceof TypeError) return { error: LOST, values: typedValues(form) };
      throw error;
    }
  }, {});
  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <Values.Provider value={state.values ?? {}}>{children}</Values.Provider>
      {state.error ? (
        <p role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          {state.error}
        </p>
      ) : null}
      <Submit label={submitLabel} variant={variant} />
    </form>
  );
}

function Submit({ label, variant }: { label: string; variant: "primary" | "secondary" }) {
  const { pending } = useFormStatus();
  const style =
    variant === "primary"
      ? "bg-gray-900 text-white hover:bg-gray-700"
      : "border border-gray-400 bg-white text-gray-900 hover:bg-gray-100";
  return (
    <button
      type="submit"
      disabled={pending}
      className={`rounded px-4 py-2 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-500 disabled:opacity-60 ${style}`}
    >
      {pending ? "Saving…" : label}
    </button>
  );
}

type FieldProps = {
  name: string;
  label: string;
  hint?: string;
  required?: boolean;
  multiline?: boolean;
  inputMode?: "numeric" | "decimal" | "text";
  maxLength?: number;
  lang?: string;
};

/** A labelled text input that keeps what was typed when the action answers with an error. */
export function Field({ name, label, hint, required, multiline, inputMode, maxLength, lang }: FieldProps) {
  const values = useContext(Values);
  // Unique per page: two forms on one page can both have a "reason" field.
  const id = useId();
  const common = {
    id,
    name,
    required,
    maxLength,
    lang,
    defaultValue: values[name] ?? "",
    "aria-describedby": hint ? `${id}-hint` : undefined,
    className: "mt-1 block w-full rounded border border-gray-400 px-3 py-2 text-base focus:border-gray-900 focus:outline-none focus:ring-1 focus:ring-gray-900",
  };
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
        {required ? <span className="text-gray-600"> (required)</span> : null}
      </label>
      {multiline ? <textarea rows={4} {...common} /> : <input type="text" inputMode={inputMode} autoComplete="off" {...common} />}
      {hint ? (
        <p id={`${id}-hint`} className="mt-1 text-xs text-gray-600">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
