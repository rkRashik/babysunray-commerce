"use client";

import { unstable_rethrow } from "next/navigation";
import { createContext, useActionState, useContext, useId } from "react";
import { useFormStatus } from "react-dom";
import type { FormState } from "../actions";

// A form bound to an Office Server Action. The server renders the idempotency key; while the action runs the
// fields and the button are disabled, and the same key is sent again on any resubmission, so an entry is
// made once. After an error, the fields show what was typed (React resets a form after each submission).

const Values = createContext<Record<string, string> | null>(null);

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
  /** Asked before an irreversible-looking action (archive, deactivate); Cancel sends nothing. */
  confirm?: string;
};

export function ActionForm({ action, idempotencyKey, hidden = {}, submitLabel, children, variant = "primary", confirm }: Props) {
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
  const errorId = useId();
  return (
    <form
      action={formAction}
      className="space-y-3"
      aria-describedby={state.error ? errorId : undefined}
      onSubmit={(event) => {
        if (confirm && !window.confirm(confirm)) event.preventDefault();
      }}
    >
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <Values.Provider value={state.values ?? null}>
        <Fields>{children}</Fields>
      </Values.Provider>
      {state.error ? (
        <p id={errorId} role="alert" className="rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          {state.error}
        </p>
      ) : null}
      <Submit label={submitLabel} variant={variant} />
    </form>
  );
}

/** Locks the inputs while saving, so nothing typed meanwhile is lost when the answer arrives. */
function Fields({ children }: { children?: React.ReactNode }) {
  const { pending } = useFormStatus();
  if (!children) return null;
  return (
    <fieldset disabled={pending} className="space-y-3 disabled:opacity-80">
      {children}
    </fieldset>
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
      aria-disabled={pending}
      className={`rounded px-4 py-2 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 focus-visible:ring-offset-2 disabled:opacity-60 ${style}`}
    >
      {pending ? "Saving…" : label}
    </button>
  );
}

/** The value to show: what was typed before an error, else the initial value. */
function useValue(name: string, initial: string | undefined): string {
  const typed = useContext(Values);
  return typed ? (typed[name] ?? "") : (initial ?? "");
}

const INPUT =
  "mt-1 block w-full rounded border border-gray-400 bg-white px-3 py-2 text-base focus:border-gray-900 focus:outline-none focus:ring-2 focus:ring-gray-900";

type FieldProps = {
  name: string;
  label: string;
  hint?: string;
  required?: boolean;
  multiline?: boolean;
  inputMode?: "numeric" | "decimal" | "text";
  maxLength?: number;
  lang?: string;
  /** Prefilled value, for editing. */
  defaultValue?: string;
};

/** A labelled text input that keeps what was typed when the action answers with an error. */
export function Field({ name, label, hint, required, multiline, inputMode, maxLength, lang, defaultValue }: FieldProps) {
  const value = useValue(name, defaultValue);
  // Unique per page: two forms on one page can both have a "reason" field.
  const id = useId();
  const common = {
    id,
    name,
    required,
    maxLength,
    lang,
    defaultValue: value,
    "aria-describedby": hint ? `${id}-hint` : undefined,
    className: INPUT,
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

/** A required choice of one option, as labelled radio buttons in a fieldset. */
export function Choice({ name, legend, options }: { name: string; legend: string; options: { value: string; label: string }[] }) {
  const value = useValue(name, undefined);
  const id = useId();
  return (
    <fieldset>
      <legend className="block text-sm font-medium">
        {legend}
        <span className="text-gray-600"> (required)</span>
      </legend>
      <div className="mt-1 flex flex-wrap gap-4">
        {options.map((option) => (
          <label key={option.value} htmlFor={`${id}-${option.value}`} className="flex items-center gap-2 text-base">
            <input
              id={`${id}-${option.value}`}
              type="radio"
              name={name}
              value={option.value}
              required
              defaultChecked={value === option.value}
              className="h-4 w-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900"
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
