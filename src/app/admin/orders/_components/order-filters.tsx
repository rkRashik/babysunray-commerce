"use client";

import { Search } from "lucide-react";
import { useRef, useTransition } from "react";
import { useAutoSubmit } from "../../_components/auto-submit";
import { searchOrdersAction } from "../actions";

/**
 * The order list's search and status filter. A choice in the status list applies at once; typing applies when the typing
 * pauses. The submit goes to a Server Action (never a GET), which keeps a name or phone number out of the address bar,
 * the browser history and the server's request log. The text box is not reset by the answer, so typing is never lost.
 */
export function OrderFilters({
  term,
  status,
  queue,
  attention,
  statuses,
}: {
  term: string;
  status: string;
  queue?: string;
  attention?: boolean;
  statuses: { value: string; label: string }[];
}) {
  const ref = useRef<HTMLFormElement>(null);
  const [pending, start] = useTransition();
  useAutoSubmit(ref);
  return (
    <form
      ref={ref}
      action={searchOrdersAction}
      aria-busy={pending}
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        start(async () => {
          await searchOrdersAction(data);
        });
      }}
    >
      {queue ? <input type="hidden" name="queue" value={queue} /> : null}
      {attention ? <input type="hidden" name="attention" value="true" /> : null}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <label htmlFor="order-search" className="block text-sm font-semibold">
            Search orders
          </label>
          <div className="relative mt-1.5">
            <Search aria-hidden="true" size={18} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-gray-500" />
            <input
              id="order-search"
              name="q"
              type="search"
              defaultValue={term}
              maxLength={100}
              autoComplete="off"
              className="of-input pl-10"
              aria-describedby="order-search-hint"
              placeholder="Order number, customer name or phone"
            />
          </div>
        </div>
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1 sm:w-52 sm:flex-none">
            <label htmlFor="order-status" className="block text-sm font-semibold">
              Order status
            </label>
            <select id="order-status" name="status" defaultValue={status} className="of-input mt-1.5">
              <option value="">Any status</option>
              {statuses.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="of-btn of-btn-ink" disabled={pending}>
            {pending ? "Searching…" : "Search"}
          </button>
        </div>
      </div>
      <p id="order-search-hint" className="mt-1.5 text-xs text-gray-600">
        Order number (ORD-000042), full mobile number or part of a name. Updates as you type.
        <span className="sr-only"> A name or phone number is never put in the page address.</span>
      </p>
    </form>
  );
}
