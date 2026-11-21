"use client";

import { FileUp } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

// A non-breaking space keeps a size and its unit on one line.
const size = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/**
 * A file input drawn as a drop area: the real <input type="file"> lies over it (transparent), so a click, a tap, the
 * keyboard (Tab, then Space or Enter), a screen reader and dragging a file onto it all work as usual, and a plain form
 * still submits it. Once a file is chosen it shows the name and size, a preview for images, and a problem found before
 * upload (wrong type or too large). The server checks every file again; this only saves a wasted upload.
 */
export function FilePicker({
  name,
  label,
  hint,
  accept,
  types,
  maxBytes,
  preview = false,
  required = false,
  disabled = false,
  onFile,
}: {
  name?: string;
  label: string;
  /** What the file must be, in words (always shown). */
  hint: string;
  accept: string;
  /** Accepted MIME types or extensions (".csv"), checked when a file is chosen. */
  types: string[];
  maxBytes: number;
  preview?: boolean;
  required?: boolean;
  disabled?: boolean;
  /** The chosen file when it passed the checks, else null. */
  onFile?: (file: File | null) => void;
}) {
  const id = useId();
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);

  function choose(chosen: File | null) {
    setFile(chosen);
    setUrl(chosen && preview && chosen.type.startsWith("image/") ? URL.createObjectURL(chosen) : null);
    const extension = chosen ? `.${chosen.name.split(".").pop()?.toLowerCase()}` : "";
    const issue = !chosen
      ? null
      : !types.includes(chosen.type) && !types.includes(extension)
        ? "This type of file cannot be used. Choose another file."
        : chosen.size > maxBytes
          ? `This file is ${size(chosen.size)}; the most is ${size(maxBytes)}. Choose a smaller file.`
          : null;
    setProblem(issue);
    // A rejected file is not sent: the form's own validation then asks for a file.
    if (issue && input.current) input.current.setCustomValidity(issue);
    else input.current?.setCustomValidity("");
    onFile?.(chosen && !issue ? chosen : null);
  }

  return (
    <div className="space-y-2">
      <div className="of-file" data-chosen={file ? "true" : undefined}>
        <span className="of-file-icon" aria-hidden="true">
          <FileUp size={20} strokeWidth={1.75} />
        </span>
        <span className="min-w-0 flex-1">
          <label htmlFor={id} className="block font-semibold">
            {label}
            {required ? <span className="font-normal text-gray-600"> (required)</span> : null}
          </label>
          <span id={`${id}-hint`} className="block text-[0.8125rem] break-words text-gray-600">
            {file ? `Chosen: ${file.name}, ${size(file.size)}` : `Choose a file or drop it here. ${hint}`}
          </span>
        </span>
        <span className="of-btn of-btn-line of-btn-sm pointer-events-none hidden sm:inline-flex" aria-hidden="true">
          {file ? "Choose another" : "Browse"}
        </span>
        <input
          ref={input}
          id={id}
          type="file"
          name={name}
          accept={accept}
          required={required}
          disabled={disabled}
          aria-describedby={problem ? `${id}-hint ${id}-problem` : `${id}-hint`}
          aria-invalid={problem ? true : undefined}
          onChange={(e) => choose(e.target.files?.[0] ?? null)}
        />
      </div>
      {problem ? (
        <p id={`${id}-problem`} role="alert" className="text-sm font-semibold text-red-800">
          {problem}
        </p>
      ) : null}
      {url && !problem ? (
        <div className="of-file-preview">
          {/* A local preview of the chosen file (a blob: URL); nothing has been uploaded yet. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt="Preview of the chosen file" className="max-h-28 w-auto max-w-full object-contain" />
          <span className="text-xs text-gray-600">Preview. Nothing is saved until you press the save button.</span>
        </div>
      ) : null}
    </div>
  );
}

/** The submit button of a plain upload form: disabled from the moment the form is sent, so one press sends it once. */
export function UploadButton({ label, busyLabel, className = "of-btn of-btn-primary", disabled = false }: { label: string; busyLabel: string; className?: string; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const form = button.current?.form;
    if (!form) return;
    // After the event has run its course: a form handler that asked "are you sure?" and was refused prevented it.
    const sent = (event: SubmitEvent) => void setTimeout(() => !event.defaultPrevented && setBusy(true));
    // Coming back with the browser's Back button may restore this page from memory: make it usable again.
    const shown = (event: PageTransitionEvent) => event.persisted && setBusy(false);
    form.addEventListener("submit", sent);
    window.addEventListener("pageshow", shown);
    return () => {
      form.removeEventListener("submit", sent);
      window.removeEventListener("pageshow", shown);
    };
  }, []);
  return (
    <button ref={button} type="submit" disabled={busy || disabled} aria-disabled={busy || disabled} className={className}>
      {busy ? busyLabel : label}
    </button>
  );
}
