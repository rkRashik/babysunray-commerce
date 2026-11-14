"use client";

import Link from "next/link";

// Shown for any unexpected failure or a missing permission. The error itself is never displayed.
export default function OfficeError() {
  return (
    <main className="mx-auto max-w-md space-y-3 px-4 py-12 text-gray-900">
      <h1 className="text-xl font-semibold">This page could not be shown</h1>
      <p className="text-sm text-gray-700">Something went wrong, or your account does not have access to this page.</p>
      <Link href="/office" className="text-sm underline">
        Back to products
      </Link>
    </main>
  );
}
