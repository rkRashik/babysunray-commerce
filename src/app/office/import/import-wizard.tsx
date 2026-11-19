"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import type { ImportIssue, ImportPlan } from "@/modules/catalogue/import-plan";

// The import wizard: choose a file, check it (preview: nothing is written), read every problem by row and column,
// then import explicitly. The same File is sent again to import, with the preview's fingerprint and key, so the
// server imports exactly what was previewed or nothing.

type Preview = {
  ok: boolean;
  format: "csv" | "xlsx";
  fingerprint: string | null;
  plan: ImportPlan;
  issues: ImportIssue[];
  warnings: ImportIssue[];
  counts: { rows: number; emptyRows: number; rejectedRows: number; products: number; variants: number };
  idempotencyKey: string;
  errorReport: string | null;
};
type Result = { import: { id: string; productsCreated: number; variantsCreated: number; products: { id: string; slug: string; nameEn: string | null; nameBn: string | null }[] }; replayed: boolean };

const BUTTON = "of-btn of-btn-primary";
const SECONDARY = "of-btn of-btn-line";
const taka = (paisa: number) => `${Math.floor(paisa / 100)}.${String(paisa % 100).padStart(2, "0")}`;

async function send(path: string, form: FormData): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(path, { method: "POST", body: form, credentials: "same-origin", cache: "no-store" });
  return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
}

export function ImportWizard() {
  const id = useId();
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState<"checking" | "importing" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const resultHeading = useRef<HTMLHeadingElement>(null);

  async function check() {
    if (!file) return setError("Choose a CSV or XLSX file first.");
    setBusy("checking");
    setError(null);
    setPreview(null);
    setResult(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const { status, body } = await send("/office/import/preview", form);
      if (status === 401) router.push("/office/login");
      else if (status !== 200) setError(typeof body.message === "string" ? body.message : "The file could not be checked. Nothing was changed.");
      else setPreview(body as unknown as Preview);
    } catch {
      setError("The server could not be reached. Nothing was changed. Try again.");
    }
    setBusy(null);
  }

  async function confirm() {
    if (!file || !preview?.fingerprint) return;
    setBusy("importing");
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("fingerprint", preview.fingerprint);
      form.append("idempotencyKey", preview.idempotencyKey);
      const { status, body } = await send("/office/import/confirm", form);
      if (status === 401) router.push("/office/login");
      else if (status !== 200) setError(typeof body.message === "string" ? body.message : "The import failed and nothing was created.");
      else {
        setResult(body as unknown as Result);
        requestAnimationFrame(() => resultHeading.current?.focus());
      }
    } catch {
      // The answer was lost: pressing Import again with the same key returns the first result, never a duplicate.
      setError("The server could not be reached, so there was no answer. Press Import again: if the first attempt was saved, it is not saved twice.");
    }
    setBusy(null);
  }

  function downloadReport() {
    if (!preview?.errorReport) return;
    const url = URL.createObjectURL(new Blob([preview.errorReport], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "catalogue-import-problems.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      <div className="space-y-3 of-card p-4 lg:p-5">
        <label htmlFor={`${id}-file`} className="block text-sm font-semibold">
          Catalogue file (CSV UTF-8 or XLSX, at most 2 MB and 1,000 rows)
        </label>
        <input
          id={`${id}-file`}
          type="file"
          accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setPreview(null);
            setResult(null);
            setError(null);
          }}
          className="of-input"
        />
        <button type="button" onClick={check} disabled={busy !== null} className={BUTTON}>
          {busy === "checking" ? "Checking…" : "Check file (nothing is saved)"}
        </button>
      </div>

      {error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">
          {error}
        </p>
      ) : null}

      {preview && !result ? (
        <section aria-labelledby={`${id}-preview`} className="space-y-4 of-card p-4 lg:p-5" data-testid="import-preview">
          <h2 id={`${id}-preview`} className="text-base font-semibold">
            Preview ({preview.format.toUpperCase()}): nothing has been saved
          </h2>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-5" data-testid="import-counts">
            <dt className="text-gray-600">Rows</dt>
            <dd>{preview.counts.rows}</dd>
            <dt className="text-gray-600">Products</dt>
            <dd>{preview.counts.products}</dd>
            <dt className="text-gray-600">SKUs</dt>
            <dd>{preview.counts.variants}</dd>
            <dt className="text-gray-600">Rows with problems</dt>
            <dd>{preview.counts.rejectedRows}</dd>
            <dt className="text-gray-600">Empty rows skipped</dt>
            <dd>{preview.counts.emptyRows}</dd>
          </dl>
          {preview.warnings.map((w) => (
            <p key={w.code} className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-950">
              {w.message}
            </p>
          ))}
          {preview.issues.length ? (
            <div className="space-y-2">
              <p role="alert" className="text-sm font-medium text-red-800">
                {preview.issues.length} problem{preview.issues.length === 1 ? "" : "s"} must be fixed in the file. Nothing can be imported until the whole file is correct.
              </p>
              <button type="button" onClick={downloadReport} className={SECONDARY}>
                Download the problem list (CSV)
              </button>
              <div className="max-h-96 overflow-auto">
                <table className="w-full text-left text-sm" data-testid="import-issues">
                  <thead className="border-b border-gray-300 text-gray-600">
                    <tr>
                      <th scope="col" className="py-1 pr-3">Row</th>
                      <th scope="col" className="py-1 pr-3">Column</th>
                      <th scope="col" className="py-1">Problem</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {preview.issues.map((i, n) => (
                      <tr key={n}>
                        <td className="py-1 pr-3 tabular-nums">{i.line ?? "file"}</td>
                        <td className="py-1 pr-3 font-mono text-xs">{i.column ?? "—"}</td>
                        <td className="py-1">{i.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
          {preview.plan.products.length ? (
            <details open={preview.ok}>
              <summary className="cursor-pointer text-sm font-medium">What would be created</summary>
              <ul className="mt-2 divide-y divide-gray-200 text-sm" aria-label="Products in the file">
                {preview.plan.products.map((p) => (
                  <li key={p.slug} className="py-2">
                    <p>
                      <span className="font-mono">{p.slug}</span> · {p.nameEn ?? "—"} · <span lang="bn">{p.nameBn ?? "—"}</span>
                      {p.categorySlug ? ` · category ${p.categorySlug}` : ""}
                      {p.featured ? " · featured" : ""}
                    </p>
                    <p className="text-gray-700">
                      {p.variants.map((v) => `${v.sku} (${[v.size, v.colour].filter(Boolean).join(", ") || "no size or colour"}) ৳ ${taka(v.pricePaisa)}`).join("; ")}
                      {p.measurements.length ? ` · ${p.measurements.length} measurement${p.measurements.length === 1 ? "" : "s"}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {preview.ok ? (
            <div className="space-y-2">
              <p className="text-sm text-gray-700">
                The import creates {preview.counts.products} draft product{preview.counts.products === 1 ? "" : "s"} and {preview.counts.variants} SKU{preview.counts.variants === 1 ? "" : "s"} with zero stock, all
                together or none. Nothing is published and no fabric statement is confirmed.
              </p>
              <button type="button" onClick={confirm} disabled={busy !== null} className={BUTTON}>
                {busy === "importing" ? "Importing…" : `Import ${preview.counts.products} product${preview.counts.products === 1 ? "" : "s"}`}
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      {result ? (
        <section aria-labelledby={`${id}-result`} className="space-y-3 rounded border border-green-300 bg-green-50 p-4" data-testid="import-result">
          <h2 id={`${id}-result`} ref={resultHeading} tabIndex={-1} className="text-base font-semibold text-green-950 focus:outline-none">
            {result.replayed ? "Already imported" : "Imported"}: {result.import.productsCreated} draft product{result.import.productsCreated === 1 ? "" : "s"}, {result.import.variantsCreated} SKU
            {result.import.variantsCreated === 1 ? "" : "s"}
          </h2>
          {result.replayed ? <p className="text-sm">This file was imported once already with this preview; nothing new was created.</p> : null}
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {result.import.products.map((p) => (
              <li key={p.id}>
                <Link href={`/office/products/${p.id}`} className="underline">
                  {p.nameEn ?? <span lang="bn">{p.nameBn}</span>}
                </Link>{" "}
                <span className="font-mono text-xs">{p.slug}</span>
              </li>
            ))}
          </ul>
          <p className="text-sm">Next: receive stock for each SKU, confirm fabric statements after checking the evidence, add photos.</p>
        </section>
      ) : null}
    </div>
  );
}
