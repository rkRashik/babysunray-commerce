"use client";

import { CheckCircle2, XCircle } from "lucide-react";
import Link from "next/link";
import { useActionState, useEffect } from "react";
import { useSelection } from "../../_components/use-selection";
import { bulkProductsAction, type ProductBulkState } from "../bulk-actions";

// The bulk bar under the product list: set a category on, or archive, the ticked draft products. Each product is changed on
// its own on the server with the version this page showed; every result is listed. Row checkboxes are `of-check`, form `products-bulk`.

export function ProductBulkBar({ batch, categories }: { batch: string; categories: { id: string; name: string; bn: boolean }[] }) {
  const [state, action, pending] = useActionState<ProductBulkState, FormData>(bulkProductsAction, {});
  const { picked, reset } = useSelection("products-bulk");
  useEffect(() => {
    if (state.results) reset();
  }, [state.results, reset]);
  const failed = state.results?.filter((r) => !r.ok).length ?? 0;
  const n = picked.count;
  return (
    <div className="of-bulkbar space-y-3">
      <form
        id="products-bulk"
        action={action}
        className={n > 0 ? "of-card flex flex-wrap items-end gap-3 border-gray-900 bg-white px-4 py-3 shadow-lg" : "hidden"}
        onSubmit={(event) => {
          const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
          if (submitter?.value === "archive" && !window.confirm(`Archive ${n} product${n === 1 ? "" : "s"}? Archived products cannot be edited or sold. Their stock history stays.`)) event.preventDefault();
        }}
      >
        <input type="hidden" name="batch" value={batch} />
        <p className="w-full text-sm font-semibold" role="status">
          {n} selected
        </p>
        <div className="min-w-48 flex-1">
          <label htmlFor="bulk-category" className="block text-sm font-semibold">
            Category
          </label>
          <select id="bulk-category" name="categoryId" className="of-input mt-1.5" defaultValue="">
            <option value="">No category</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id} lang={c.bn ? "bn" : undefined}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" name="bulkAction" value="category" className="of-btn of-btn-primary" disabled={pending || n === 0}>
          {pending ? "Working…" : `Apply category to ${n}`}
        </button>
        <button type="submit" name="bulkAction" value="archive" className="of-btn of-btn-line" disabled={pending || n === 0}>
          Archive {n}
        </button>
      </form>
      {state.error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">
          {state.error}
        </p>
      ) : null}
      {state.results ? (
        <section aria-label="Bulk result" className="of-card space-y-2 p-4">
          <p role="status" className="text-sm font-semibold">
            {failed === 0 ? `All ${state.results.length} products updated.` : `${state.results.length - failed} updated, ${failed} not updated.`}
          </p>
          <ul className="divide-y divide-gray-200 text-sm">
            {state.results.map((r) => (
              <li key={r.productId} className="flex items-start gap-2 py-1.5" data-ok={r.ok}>
                {r.ok ? <CheckCircle2 aria-hidden="true" size={16} className="mt-0.5 shrink-0 text-green-700" /> : <XCircle aria-hidden="true" size={16} className="mt-0.5 shrink-0 text-red-700" />}
                <span>
                  <Link href={`/admin/products/${r.productId}`} className="font-medium underline underline-offset-2">
                    {r.name}
                  </Link>
                  : {r.message}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
