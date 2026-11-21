"use client";

import { ImageUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { FilePicker, UploadButton } from "../../_components/file-picker";

const TYPES = ["image/png", "image/jpeg", "image/webp"];
const MAX_BYTES = 5 * 1024 * 1024;
const RULES = "PNG, JPEG or WebP, at most 5 MB. A PNG with a transparent background works best.";

/**
 * The logo card of Store settings. By default it shows the logo in use and where it comes from; "Replace logo" opens a
 * file picker with a preview, Save logo and Cancel. Upload and removal are the plain forms of /admin/settings/store/logo
 * (session, origin, permission, byte limit, image re-encoding and version check on the server, unchanged). A failed or
 * cancelled replacement leaves the logo in use as it is.
 */
export function LogoSection({
  logo,
  source,
  uploaded,
  fallback,
  version,
  uploadKey,
  removeKey,
  error,
  disabled,
}: {
  /** The logo in use, rendered on the server. */
  logo: React.ReactNode;
  source: string;
  /** Whether a logo was uploaded here (it can then be removed). */
  uploaded: boolean;
  /** What customers see after removing the uploaded logo. */
  fallback: string;
  version: string;
  uploadKey: string;
  removeKey: string;
  error?: string;
  disabled: boolean;
}) {
  const [replacing, setReplacing] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const replaceButton = useRef<HTMLButtonElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const closed = useRef(false);

  useEffect(() => {
    if (replacing) form.current?.querySelector<HTMLInputElement>("input[type=file]")?.focus();
    else if (closed.current) replaceButton.current?.focus();
    closed.current = false;
  }, [replacing]);

  function cancel() {
    closed.current = true;
    setFile(null);
    setReplacing(false);
  }

  return (
    <section aria-labelledby="section-logo" className="of-card space-y-4 p-5 lg:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="section-logo" className="text-[1.0625rem] font-bold">
          Logo
        </h2>
        {replacing ? (
          <span className="of-pill" data-tone="wait">
            Replacing
          </span>
        ) : (
          <button ref={replaceButton} type="button" onClick={() => setReplacing(true)} disabled={disabled} className="of-btn of-btn-line of-btn-sm">
            <ImageUp aria-hidden="true" size={16} />
            Replace logo
          </button>
        )}
      </div>
      {error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">
          {error} The logo in use has not changed.
        </p>
      ) : null}
      <figure className="space-y-2.5">
        <div className="flex min-h-24 items-center rounded-xl bg-gray-50 px-5 py-4">{logo}</div>
        <figcaption className="flex flex-wrap items-center gap-2 text-sm text-gray-700">
          <span className="of-pill" data-tone="ok">
            In use
          </span>
          <span data-testid="logo-source">{source}</span>
        </figcaption>
      </figure>
      {replacing ? (
        <form ref={form} action="/admin/settings/store/logo" method="post" encType="multipart/form-data" className="space-y-3 border-t border-gray-200 pt-4">
          <input type="hidden" name="idempotencyKey" value={uploadKey} />
          <input type="hidden" name="version" value={version} />
          <FilePicker name="logo" label="New logo" hint={RULES} accept={TYPES.join(",")} types={TYPES} maxBytes={MAX_BYTES} preview required onFile={setFile} />
          <p className="text-[0.8125rem] text-gray-600">The new logo replaces the one above in the shop and in Admin. The image is never redrawn; it is only resized to at most 1200 pixels and saved without its camera details.</p>
          <div className="flex flex-wrap gap-2">
            <UploadButton label="Save logo" busyLabel="Saving logo…" disabled={!file} />
            <button type="button" onClick={cancel} className="of-btn of-btn-line">
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[0.8125rem] text-gray-600">{RULES}</p>
          {uploaded ? (
            <form
              action="/admin/settings/store/logo"
              method="post"
              encType="multipart/form-data"
              onSubmit={(event) => {
                if (!window.confirm(`Remove the uploaded logo? The shop then shows ${fallback}.`)) event.preventDefault();
              }}
            >
              <input type="hidden" name="idempotencyKey" value={removeKey} />
              <input type="hidden" name="version" value={version} />
              <input type="hidden" name="remove" value="1" />
              <UploadButton label="Remove uploaded logo" busyLabel="Removing…" className="of-btn of-btn-line of-btn-sm" disabled={disabled} />
            </form>
          ) : null}
        </div>
      )}
    </section>
  );
}
