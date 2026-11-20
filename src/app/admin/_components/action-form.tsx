"use client";

import { unstable_rethrow } from "next/navigation";
import { createContext, useActionState, useContext, useId } from "react";
import { useFormStatus } from "react-dom";
import type { FormState } from "../actions";

// A form bound to an Admin Server Action. The server renders the idempotency key; while the action runs the
// fields and the button are disabled, and the same key is sent again on any resubmission, so an entry is
// made once. After an error, the fields show what was typed (React resets a form after each submission).

const Values = createContext<Record<string, string> | null>(null);

function typedValues(form: FormData): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [name, value] of form) if (typeof value === "string" && /^[a-zA-Z][a-zA-Z0-9]*$/.test(name) && name !== "idempotencyKey") values[name] = value;
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
  /** A small inline button, for a quick action in a table row. */
  compact?: boolean;
};

export function ActionForm({ action, idempotencyKey, hidden = {}, submitLabel, children, variant = "primary", confirm, compact = false }: Props) {
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
      className={compact ? "flex flex-col items-end gap-1.5" : "space-y-3"}
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
        <p id={errorId} role="alert" className={compact ? "max-w-56 rounded-lg bg-red-50 px-2.5 py-1.5 text-xs font-semibold text-red-800" : "rounded-xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-800"}>
          {state.error}
        </p>
      ) : null}
      {state.link ? <OneTimeLink link={state.link} /> : null}
      <Submit label={submitLabel} variant={variant} compact={compact} />
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

function Submit({ label, variant, compact }: { label: string; variant: "primary" | "secondary"; compact: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} aria-disabled={pending} className={`of-btn ${variant === "primary" ? "of-btn-primary" : "of-btn-line"}${compact ? " of-btn-sm" : ""}`}>
      {pending ? "Saving…" : label}
    </button>
  );
}

/** The value to show: what was typed before an error, else the initial value. */
function useValue(name: string, initial: string | undefined): string {
  const typed = useContext(Values);
  return typed ? (typed[name] ?? "") : (initial ?? "");
}

const INPUT = "of-input mt-1.5";

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
      <label htmlFor={id} className="block text-sm font-semibold">
        {label}
        {required ? <span className="font-normal text-gray-600"> (required)</span> : null}
      </label>
      {multiline ? <textarea rows={4} {...common} /> : <input type="text" inputMode={inputMode} autoComplete="off" {...common} />}
      {hint ? (
        <p id={`${id}-hint`} className="mt-1.5 text-[0.8125rem] text-gray-600">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** A link that exists only in this answer (a tracking link): shown once, never stored by the page. */
function OneTimeLink({ link }: { link: string }) {
  const id = useId();
  return (
    <div role="status" className="space-y-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
      <label htmlFor={id} className="block font-semibold">
        New tracking link. Send it to the customer now: it is shown only once and cannot be shown again.
      </label>
      <input id={id} readOnly value={link} className={`${INPUT} font-mono text-sm`} onFocus={(e) => e.currentTarget.select()} />
    </div>
  );
}

/** A labelled checkbox (sent as "on" when ticked). */
export function Checkbox({ name, label, defaultChecked }: { name: string; label: string; defaultChecked?: boolean }) {
  const typed = useContext(Values);
  const id = useId();
  return (
    <div className="flex min-h-11 items-center gap-2.5">
      <input id={id} type="checkbox" name={name} defaultChecked={typed ? typed[name] === "on" : defaultChecked} className="h-5 w-5 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900" />
      <label htmlFor={id} className="text-base">
        {label}
      </label>
    </div>
  );
}

/** A required choice of one option, as labelled radio buttons in a fieldset. */
export function Choice({ name, legend, options, defaultValue }: { name: string; legend: string; options: { value: string; label: string }[]; defaultValue?: string }) {
  const value = useValue(name, defaultValue);
  const id = useId();
  return (
    <fieldset>
      <legend className="block text-sm font-semibold">
        {legend}
        <span className="font-normal text-gray-600"> (required)</span>
      </legend>
      <div className="mt-1.5 flex flex-wrap gap-2">
        {options.map((option) => (
          <label
            key={option.value}
            htmlFor={`${id}-${option.value}`}
            className="flex min-h-11 cursor-pointer items-center gap-2 rounded-full border-[1.5px] border-gray-300 bg-white px-3.5 text-[0.9375rem] font-medium transition-colors hover:border-gray-900 has-[:checked]:border-gray-900 has-[:checked]:bg-amber-100"
          >
            <input
              id={`${id}-${option.value}`}
              type="radio"
              name={name}
              value={option.value}
              required
              defaultChecked={value === option.value}
              className="h-4.5 w-4.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900"
            />
            {option.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** A labelled drop-down that keeps the chosen value when the action answers with an error. */
export function SelectField({ name, label, options, defaultValue, hint }: { name: string; label: string; options: { value: string; label: string; lang?: string }[]; defaultValue?: string; hint?: string }) {
  const value = useValue(name, defaultValue);
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-semibold">
        {label}
      </label>
      <select id={id} name={name} defaultValue={value} aria-describedby={hint ? `${id}-hint` : undefined} className={INPUT}>
        {options.map((o) => (
          <option key={o.value} value={o.value} lang={o.lang}>
            {o.label}
          </option>
        ))}
      </select>
      {hint ? (
        <p id={`${id}-hint`} className="mt-1.5 text-[0.8125rem] text-gray-600">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/** An input for a table cell, named by its column and row header (aria-label), keeping typed values after an error. */
export function CellInput({ name, label, defaultValue, inputMode = "decimal" }: { name: string; label: string; defaultValue?: string; inputMode?: "decimal" | "numeric" | "text" }) {
  const value = useValue(name, defaultValue);
  return <input type="text" name={name} aria-label={label} inputMode={inputMode} autoComplete="off" defaultValue={value} className="of-input w-20 px-2" />;
}
