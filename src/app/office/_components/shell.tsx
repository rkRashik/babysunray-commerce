import Link from "next/link";
import { SignOutButton } from "./auth-forms";

// Neutral internal layout for the Owner Office. Functional only: not an approved visual design.
export function OfficeShell({ title, children, notice }: { title: string; children: React.ReactNode; notice?: string }) {
  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <header className="border-b border-gray-300 bg-white">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <nav aria-label="Owner Office" className="flex flex-wrap items-center gap-4 text-sm">
            <span className="font-semibold">Owner Office</span>
            <Link href="/office" className="underline-offset-2 hover:underline">
              Products
            </Link>
            <Link href="/office/products/new" className="underline-offset-2 hover:underline">
              New product
            </Link>
          </nav>
          <SignOutButton />
        </div>
      </header>
      <main className="mx-auto max-w-4xl space-y-6 px-4 py-6">
        <h1 className="text-xl font-semibold">{title}</h1>
        {notice ? (
          <p role="status" className="rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-900">
            {notice}
          </p>
        ) : null}
        {children}
      </main>
    </div>
  );
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded border border-gray-300 bg-white p-4">
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}

const dhaka = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dhaka", dateStyle: "medium", timeStyle: "short" });
/** Stored in UTC, shown in Bangladesh time. */
export const formatTime = (date: Date) => `${dhaka.format(date)} (Dhaka)`;

const NOTICES: Record<string, string> = {
  created: "Draft product created.",
  variant: "Variant added.",
  archived: "Product archived.",
  deactivated: "Variant deactivated.",
  received: "Stock receipt recorded.",
  adjusted: "Stock adjustment recorded.",
};
export const noticeFor = (done: string | string[] | undefined) => (typeof done === "string" ? NOTICES[done] : undefined);
