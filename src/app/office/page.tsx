import Link from "next/link";
import { productCursorCodec } from "@/api/v1/schemas";
import { getDb } from "@/db/client";
import { listProducts } from "@/modules/catalogue/service";
import { OfficeShell, formatTime } from "./_components/shell";
import { requireOffice } from "./_lib/session";

export const metadata = { title: "Products · Owner Office" };

const STATUSES = ["draft", "archived"] as const;
const PAGE_SIZE = 25;

// Product list, oldest first in pages of 25. Every product is a draft or archived; none is public.
export default async function ProductsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await requireOffice("catalog:read");
  const query = await searchParams;
  const status = STATUSES.find((s) => s === query.status);
  const after = typeof query.cursor === "string" ? (productCursorCodec.decode(query.cursor) ?? undefined) : undefined;
  const page = await listProducts(getDb(), { limit: PAGE_SIZE, status, after });
  const last = page.items.at(-1);
  const next = page.hasMore && last ? `?${new URLSearchParams({ ...(status ? { status } : {}), cursor: productCursorCodec.encode(last.key) })}` : null;
  const filter = (label: string, value?: string) => (
    <Link
      href={value ? `/office?status=${value}` : "/office"}
      aria-current={status === value ? "page" : undefined}
      className={`rounded border px-3 py-1 ${status === value ? "border-gray-900 bg-gray-900 text-white" : "border-gray-400 bg-white"}`}
    >
      {label}
    </Link>
  );

  return (
    <OfficeShell title="Products">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {filter("All")}
        {filter("Draft", "draft")}
        {filter("Archived", "archived")}
      </div>
      {page.items.length === 0 ? (
        <p className="text-sm text-gray-700">
          No products yet. <Link href="/office/products/new" className="underline">Create a draft product</Link>.
        </p>
      ) : (
        <ul className="divide-y divide-gray-200 rounded border border-gray-300 bg-white">
          {page.items.map((p) => (
            <li key={p.id} className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-3">
              <Link href={`/office/products/${p.id}`} className="font-medium underline-offset-2 hover:underline">
                {p.nameEn ?? p.nameBn}
                {p.nameEn && p.nameBn ? <span lang="bn" className="ml-2 font-normal text-gray-700">{p.nameBn}</span> : null}
              </Link>
              <span className="text-xs text-gray-600">
                {p.status} · {p.slug} · created {formatTime(p.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {next ? (
        <Link href={`/office${next}`} className="inline-block text-sm underline">
          Next page
        </Link>
      ) : null}
    </OfficeShell>
  );
}
