import { getDb } from "@/db/client";
import { listImports } from "@/modules/catalogue/import-service";
import { AdminShell, Section, formatTime } from "../_components/shell";
import { requireAdmin } from "../_lib/session";
import { ImportWizard } from "./import-wizard";

export const metadata = { title: "Import products · Admin" };

// Bulk import of new draft products (docs/operations/catalogue-import.md): create-only and all or nothing.
export default async function ImportPage() {
  await requireAdmin("catalog:read", "catalog:write");
  const recent = await listImports(getDb());
  return (
    <AdminShell title="Import products" current="products">
      <Section title="1. Get the template">
        <p className="text-sm text-gray-700">
          One row per SKU. Rows with the same product_slug make one product; its name and other product columns are read from its first row. Prices are in Taka (850 or 850.50),
          measurements in centimetres. The import only creates new draft products and SKUs with zero stock: it never changes an existing product, receives stock, publishes or confirms
          a fabric statement.
        </p>
        <div className="flex flex-wrap gap-3 text-sm">
          {/* A file download from a route handler, not a page (the rule mistakes it for the shop's /[lang] pages). */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a href="/admin/import/template?format=xlsx" className="inline-flex min-h-11 items-center underline lg:min-h-0">
            Download the XLSX template
          </a>
          {/* A file download from a route handler, not a page (the rule mistakes it for the shop's /[lang] pages). */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a href="/admin/import/template?format=csv" className="inline-flex min-h-11 items-center underline lg:min-h-0">
            Download the CSV template
          </a>
        </div>
      </Section>
      <Section title="2. Check and import a file">
        <ImportWizard />
      </Section>
      <Section title="Recent imports">
        {recent.length === 0 ? (
          <p className="text-sm text-gray-700">No imports yet.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {recent.map((r) => (
              <li key={r.id}>
                {formatTime(r.createdAt)}: {r.productsCreated} product{r.productsCreated === 1 ? "" : "s"}, {r.variantsCreated} SKU{r.variantsCreated === 1 ? "" : "s"} ({r.format.toUpperCase()})
              </li>
            ))}
          </ul>
        )}
      </Section>
    </AdminShell>
  );
}
