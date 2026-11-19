import { CircleHelp, Link2, Lock, Package } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SunMark } from "@/app/_design/sun-mark";
import { dictionary, isLang } from "@/modules/storefront/i18n";
import { requireOffice } from "../../../_lib/session";

// "My order" in the tab bar. A guest has no account, so there is nothing to list: each order is followed with its own
// private link (founder rule K), which opens the tracking page (/track). This page says so in both languages; it holds no
// order data and asks for nothing.
export default async function PreviewOrderHelp({ params }: { params: Promise<{ lang: string }> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  await requireOffice("storefront:preview");
  const t = dictionary(lang);
  const items = [
    { icon: Link2, text: t.orderPageBody },
    { icon: Lock, text: t.orderPageKeep },
    { icon: CircleHelp, text: t.orderPageLost },
  ];
  return (
    <div className="mx-auto max-w-2xl space-y-8 pt-2">
      <div className="sf-enter space-y-4 text-center">
        <SunMark className="mx-auto h-9 w-16 text-sf-sun" />
        <h1 className="sf-display text-[2.25rem] lg:text-[3rem]">{t.orderPageTitle}</h1>
      </div>
      <ul className="space-y-3">
        {items.map(({ icon: Icon, text }) => (
          <li key={text} className="sf-card flex gap-4 p-5">
            <span aria-hidden="true" className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-sf-sun-soft text-sf-sun-deep">
              <Icon size={22} strokeWidth={1.75} />
            </span>
            <p className="pt-1.5 leading-relaxed">{text}</p>
          </li>
        ))}
      </ul>
      <Link href="/track" className="sf-btn sf-btn-ink sf-btn-lg w-full gap-2 sm:w-auto">
        <Package aria-hidden="true" size={20} strokeWidth={1.75} />
        {t.orderPageOpen}
      </Link>
    </div>
  );
}
