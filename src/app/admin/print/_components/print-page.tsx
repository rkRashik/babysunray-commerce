import Link from "next/link";
import { formatTime, adminSurface } from "../../_components/shell";
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
    <div className={`${adminSurface} min-h-screen print:bg-white`}>
      <div className="no-print flex flex-wrap items-center gap-4 border-b border-gray-200 bg-white px-4 py-3 text-sm">
        <Link href={back.href} className="of-btn of-btn-line">
          {back.label}
        </Link>
        <PrintButton />
      </div>
      <main className="print-sheet mx-auto my-4 max-w-[190mm] space-y-4 bg-white px-4 py-4 text-black shadow-sm print:my-0 print:shadow-none sm:px-8 sm:py-8">
        <header className="border-b border-black pb-2">
          <h1 className="text-lg font-semibold">{title}</h1>
          {scope ? <p className="text-sm">{scope}</p> : null}
          <p className="text-xs">Generated {formatTime(generatedAt)} · Admin · internal document</p>
        </header>
        {children}
      </main>
    </div>
  );
}

export const TABLE = "w-full border-collapse text-left text-sm [&_td]:border [&_td]:border-gray-400 [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-gray-400 [&_th]:px-2 [&_th]:py-1 [&_th]:font-semibold";
