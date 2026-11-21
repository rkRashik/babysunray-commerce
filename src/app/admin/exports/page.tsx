import { getDb } from "@/db/client";
import {
  DATASETS,
  listRecentExports,
  MAX_EXPORT_ROWS,
} from "@/modules/exports/service";
import { MAX_RANGE_DAYS } from "@/modules/reports/dates";
import { AdminShell, Section, formatTime } from "../_components/shell";
import { requireAdmin } from "../_lib/session";
import { label } from "../orders/_components/labels";

export const metadata = { title: "Exports · Admin" };

const FIELD = "of-input mt-1.5";

const ERRORS: Record<string, string> = {
  invalid:
    "That export could not be made: check the dataset, format and filters. Some filters apply only to some datasets (see the list).",
  too_large: `That export has more than ${MAX_EXPORT_ROWS} rows. Choose a shorter date range or more filters.`,
  failed: "Something went wrong and no file was made. Please try again.",
};

const SELECTS = {
  source: ["website", "messenger", "whatsapp", "other"],
  orderStatus: [
    "pending_verification",
    "verification_expired",
    "confirmed",
    "cancelled",
    "closed",
  ],
  fulfilmentStatus: [
    "unfulfilled",
    "packed",
    "dispatched",
    "delivered",
    "rto",
    "rto_received",
  ],
  paymentStatus: ["unpaid", "partially_collected", "collected", "settled"],
} as const;
const SELECT_LABELS = {
  source: "Order source",
  orderStatus: "Order status",
  fulfilmentStatus: "Fulfilment status",
  paymentStatus: "Payment status",
};

// Export form and the export audit list. The form posts to /admin/exports/download (a route handler that
// streams the file); every request is recorded before any data is read.
export default async function ExportsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const principal = await requireAdmin("exports:create");
  const { error } = await searchParams;
  const recent = await listRecentExports(getDb(), principal);

  return (
    <AdminShell title="Exports" current="exports">
      <p className="text-sm text-gray-700">
        Exports are files for reading and keeping records. They are not a
        database backup and cannot restore the system. Some contain customer
        names, phone numbers and addresses: keep those files private and delete
        copies you no longer need.
      </p>
      {typeof error === "string" && Object.hasOwn(ERRORS, error) ? (
        <p
          role="alert"
          className="rounded-xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-800"
        >
          {ERRORS[error]}
        </p>
      ) : null}
      <Section title="New export">
        <form
          method="post"
          action="/admin/exports/download"
          className="space-y-4"
        >
          <div>
            <label htmlFor="dataset" className="block text-sm font-semibold">
              Dataset <span className="text-gray-600">(required)</span>
            </label>
            <select
              id="dataset"
              name="dataset"
              required
              className={FIELD}
              defaultValue=""
            >
              <option value="" disabled>
                Choose a dataset
              </option>
              {DATASETS.map((d) => (
                <option key={d.name} value={d.name}>
                  {d.title}
                  {d.personalData ? " (contains customer contact details)" : ""}
                </option>
              ))}
            </select>
          </div>
          <fieldset>
            <legend className="block text-sm font-semibold">
              Format <span className="text-gray-600">(required)</span>
            </legend>
            <div className="mt-1 flex flex-wrap gap-4">
              {[
                ["xlsx", "Excel (.xlsx)"],
                ["csv", "CSV (UTF-8)"],
                ["json", "JSON"],
              ].map(([value, text]) => (
                <label
                  key={value}
                  className="flex min-h-11 items-center gap-2 text-base lg:min-h-0"
                >
                  <input
                    type="radio"
                    name="format"
                    value={value}
                    required
                    defaultChecked={value === "xlsx"}
                    className="h-4 w-4"
                  />
                  {text}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">
              Filters (optional; leave empty for a complete export)
            </legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="from" className="block text-sm font-semibold">
                  From (Dhaka date)
                </label>
                <input id="from" name="from" type="date" className={FIELD} />
              </div>
              <div>
                <label htmlFor="to" className="block text-sm font-semibold">
                  To (included)
                </label>
                <input
                  id="to"
                  name="to"
                  type="date"
                  className={FIELD}
                  aria-describedby="to-hint"
                />
                <p id="to-hint" className="mt-1 text-xs text-gray-600">
                  Both dates or neither; at most {MAX_RANGE_DAYS} days.
                </p>
              </div>
              {(Object.keys(SELECTS) as (keyof typeof SELECTS)[]).map(
                (name) => (
                  <div key={name}>
                    <label
                      htmlFor={name}
                      className="block text-sm font-semibold"
                    >
                      {SELECT_LABELS[name]}
                    </label>
                    <select
                      id={name}
                      name={name}
                      className={FIELD}
                      defaultValue=""
                    >
                      <option value="">Any</option>
                      {SELECTS[name].map((v) => (
                        <option key={v} value={v}>
                          {label(v)}
                        </option>
                      ))}
                    </select>
                  </div>
                ),
              )}
            </div>
          </fieldset>
          <button type="submit" className="of-btn of-btn-primary">
            Download
          </button>
        </form>
      </Section>

      <Section title="What each dataset contains">
        <p className="text-sm text-gray-700">
          Datasets marked &quot;contains customer contact details&quot; in the
          list above hold names, phone numbers and addresses: keep those files
          private and delete them when done.
        </p>
        <details className="text-sm">
          <summary className="cursor-pointer py-3 font-semibold lg:py-1">
            Show all {DATASETS.length} datasets, their date filters and file
            notes
          </summary>
          <ul className="mt-2 space-y-2 text-sm">
            {DATASETS.map((d) => (
              <li key={d.name}>
                <span className="font-medium">{d.title}</span>{" "}
                <span className="font-mono text-xs">({d.name})</span>
                {d.personalData ? (
                  <strong className="ml-1 text-red-800">
                    Contains customer contact details.
                  </strong>
                ) : null}
                <br />
                <span className="text-gray-700">
                  Date filter:{" "}
                  {d.dateColumn ? d.dateColumn.description : "none"}. Order
                  source and status filters: {d.orderFilters ? "yes" : "no"}.
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-gray-600">
            At most {MAX_EXPORT_ROWS} rows per file. Amounts are whole paisa
            (100 paisa = ৳1). In Excel and CSV files, times are Bangladesh time;
            in JSON they are UTC. CSV opened directly in Excel loses the leading
            zero of phone numbers (Excel guesses types): use the Excel format
            for phone numbers. In CSV, a text value that starts with = + − @ or
            a tab is written with a leading apostrophe so it cannot run as a
            formula.
          </p>
        </details>
      </Section>

      <Section title="Recent exports (audit)">
        {recent.length === 0 ? (
          <p className="text-sm text-gray-700">No exports yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table
              className="w-full text-left text-sm"
              data-testid="export-audit"
            >
              <thead className="border-b border-gray-300 text-gray-600">
                <tr>
                  <th scope="col" className="py-1 pr-3">
                    When
                  </th>
                  <th scope="col" className="py-1 pr-3">
                    Dataset
                  </th>
                  <th scope="col" className="py-1 pr-3">
                    Format
                  </th>
                  <th scope="col" className="py-1 pr-3">
                    Scope
                  </th>
                  <th scope="col" className="py-1">
                    Filters
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {recent.map((r) => (
                  <tr key={r.id}>
                    <td className="py-1 pr-3 whitespace-nowrap">
                      {formatTime(r.createdAt)}
                    </td>
                    <td className="py-1 pr-3">{r.dataset}</td>
                    <td className="py-1 pr-3">{r.format}</td>
                    <td className="py-1 pr-3">{r.scope}</td>
                    <td className="py-1 font-mono text-xs break-all">
                      {JSON.stringify(r.filters)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </AdminShell>
  );
}
