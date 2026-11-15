import Link from "next/link";
import { formatTime } from "../../_components/shell";
import { PrintButton } from "./print-button";

// A printable Owner document: plain black-on-white A4 layout (see the print rules in globals.css), with the
// title, what it covers and when it was generated at the top. No external fonts, images or scripts. Shows no
// business name, address or logo: no approved business identity configuration exists (requirement D-9).
export function PrintPage({
  title,
  scope,
  generatedAt,
  back,
  children,
}: {
  title: string;
  scope?: string;
  generatedAt: Date;
  back: { href: string; label: string };
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-white text-black">
      <div className="no-print flex flex-wrap items-center gap-4 border-b border-gray-300 px-4 py-3 text-sm">
        <Link href={back.href} className="underline">
          {back.label}
        </Link>
        <PrintButton />
      </div>
      <main className="print-sheet mx-auto max-w-[190mm] space-y-4 px-4 py-4">
        <header className="border-b border-black pb-2">
          <h1 className="text-lg font-semibold">{title}</h1>
          {scope ? <p className="text-sm">{scope}</p> : null}
          <p className="text-xs">Generated {formatTime(generatedAt)} · Owner Office · internal document</p>
        </header>
        {children}
      </main>
    </div>
  );
}

export const TABLE = "w-full border-collapse text-left text-sm [&_td]:border [&_td]:border-gray-400 [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-gray-400 [&_th]:px-2 [&_th]:py-1 [&_th]:font-semibold";
