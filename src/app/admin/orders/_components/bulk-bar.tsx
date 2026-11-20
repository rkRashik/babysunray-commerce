"use client";

import { CheckCircle2, XCircle } from "lucide-react";
import Link from "next/link";
import { useActionState, useEffect } from "react";
import { useSelection } from "../../_components/use-selection";
import { type BulkState, bulkOrdersAction } from "../actions";

// The bulk bar under the order table. Row checkboxes (class `of-check`, form `orders-bulk`, `data-step` = the step that row
// can take) live in the server-rendered table; this bar counts the ticked ones and offers the one step they share. Each
// order is then changed on its own on the server, with the version this page showed, and every result is listed.

const STEPS = {
  pack: { button: (n: number) => `Mark ${n} packed`, ask: (n: number) => `Mark ${n} order${n === 1 ? "" : "s"} as packed?` },
  dispatch: {
    button: (n: number) => `Dispatch ${n} order${n === 1 ? "" : "s"}`,
    ask: (n: number) => `Dispatch ${n} order${n === 1 ? "" : "s"}? Their stock is deducted and they can no longer be cancelled. This is not undone in bulk.`,
  },
} as const;
type Step = keyof typeof STEPS;
export function BulkBar({ batch }: { batch: string }) {
  const [state, action, pending] = useActionState<BulkState, FormData>(bulkOrdersAction, {});
  const { picked, reset } = useSelection("orders-bulk");

  // After an answer, untick everything: the rows that changed have new versions and may have left this list.
  useEffect(() => {
    if (state.results) reset();
  }, [state.results, reset]);

  const step = picked.steps.length === 1 && picked.steps[0] in STEPS ? (picked.steps[0] as Step) : null;
  const failed = state.results?.filter((r) => !r.ok).length ?? 0;

  return (
    <div className="of-bulkbar space-y-3">
      {picked.count > 0 ? (
        <form
          id="orders-bulk"
          action={action}
          className="of-card flex flex-wrap items-center justify-between gap-3 border-gray-900 bg-white px-4 py-3 shadow-lg"
          onSubmit={(event) => {
            if (step && !window.confirm(STEPS[step].ask(picked.count))) event.preventDefault();
          }}
        >
          <input type="hidden" name="batch" value={batch} />
          {step ? <input type="hidden" name="bulkAction" value={step} /> : null}
          <p className="text-sm font-semibold" role="status">
            {picked.count} selected
            {step ? null : <span className="font-normal text-gray-700"> · they need different steps. Pick a queue such as To pack, then select.</span>}
          </p>
          <button type="submit" className="of-btn of-btn-primary" disabled={!step || pending}>
            {pending ? "Working…" : step ? STEPS[step].button(picked.count) : "Choose orders with the same step"}
          </button>
        </form>
      ) : (
        <form id="orders-bulk" action={action} className="hidden">
          <input type="hidden" name="batch" value={batch} />
        </form>
      )}
      {state.error ? (
        <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">
          {state.error}
        </p>
      ) : null}
      {state.results ? (
        <section aria-label="Bulk result" className="of-card space-y-2 p-4">
          <p role="status" className="text-sm font-semibold">
            {failed === 0 ? `All ${state.results.length} orders updated.` : `${state.results.length - failed} updated, ${failed} not updated.`}
          </p>
          <ul className="divide-y divide-gray-200 text-sm">
            {state.results.map((r) => (
              <li key={r.orderId} className="flex items-start gap-2 py-1.5" data-ok={r.ok}>
                {r.ok ? <CheckCircle2 aria-hidden="true" size={16} className="mt-0.5 shrink-0 text-green-700" /> : <XCircle aria-hidden="true" size={16} className="mt-0.5 shrink-0 text-red-700" />}
                <span>
                  <Link href={`/admin/orders/${r.orderId}`} className="font-medium underline underline-offset-2">
                    {r.number === null ? "Order" : `ORD-${String(r.number).padStart(6, "0")}`}
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
