"use client";

import Link from "next/link";
import { flFontVariables } from "@/app/_design/fonts";

// Shown for any unexpected failure or a missing permission. The error itself is never displayed.
export default function OfficeError() {
  return (
    <main className={`of ${flFontVariables} min-h-screen px-4 py-16`}>
      <div className="of-card mx-auto max-w-md space-y-4 p-6">
        <h1 className="text-xl font-bold">This page could not be shown</h1>
        <p className="text-sm text-gray-700">Something went wrong, or your account does not have access to this page.</p>
        <Link href="/office" className="of-btn of-btn-line">
          Back to products
        </Link>
      </div>
    </main>
  );
}
