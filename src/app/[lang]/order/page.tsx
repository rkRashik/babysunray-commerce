import { CircleHelp, Link2, Lock, Package } from "lucide-react";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireShop } from "@/app/_shop/access";
import { SunMark } from "@/app/_design/sun-mark";
import { CustomerSignOutButton, GoogleSignInButton } from "@/app/office/storefront-preview/_components/customer-auth";
import { getDb } from "@/db/client";
import { customerOrderList } from "@/modules/customers/orders";
import { currentCustomer, customerSignInAvailable } from "@/modules/customers/server";
import { dictionary, formatTaka, isLang, toBnDigits } from "@/modules/storefront/i18n";

// "My order": how guest orders are followed (each with its own private link, founder rule K), and, for a customer who chose
// to sign in with Google, the orders they placed while signed in. Signing in is optional and never needed to order.
export default async function ShopOrder({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  await requireShop();
  const t = dictionary(lang);
  const customer = await currentCustomer(await headers()).catch(() => null);
  const orders = customer ? await customerOrderList(getDb(), customer.id) : [];
  const failed = (await searchParams).signin === "failed";
  const when = (d: Date) => {
    const text = new Intl.DateTimeFormat(lang === "bn" ? "bn-BD" : "en-GB", { dateStyle: "medium", timeZone: "Asia/Dhaka" }).format(d);
    return lang === "bn" ? toBnDigits(text) : text;
  };
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

      <section aria-labelledby="sf-account" className="sf-card space-y-4 p-5" data-testid="account">
        <h2 id="sf-account" className="sf-plain text-lg">
          {t.accountTitle}
        </h2>
        {failed ? (
          <p role="alert" className="sf-note font-semibold" data-tone="bad">
            {t.signInFailed}
          </p>
        ) : null}
        {customer ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="font-semibold" data-testid="customer-name">
                {t.signedInAs(customer.name)}
              </p>
              <CustomerSignOutButton lang={lang} />
            </div>
            <h3 className="sf-plain">{t.myOrders}</h3>
            {orders.length ? (
              <ul className="divide-y divide-sf-line" data-testid="customer-orders">
                {orders.map((o) => (
                  <li key={o.reference} className="flex flex-wrap items-baseline justify-between gap-2 py-3">
                    <span className="sf-num font-semibold" lang="en">
                      {o.reference}
                    </span>
                    <span className="text-[0.9375rem] text-sf-ink-2">{when(o.placedAt)}</span>
                    <span className="w-full text-[0.9375rem]">{t.orderStatus[o.orderStatus] ?? o.orderStatus}</span>
                    <span className="sf-num font-semibold">{formatTaka(o.totalPaisa, lang)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sf-ink-2">{t.myOrdersEmpty}</p>
            )}
            <p className="sf-hint">{t.myOrdersGuest}</p>
          </>
        ) : customerSignInAvailable() ? (
          <>
            <p>{t.signInWhy}</p>
            <GoogleSignInButton lang={lang} returnTo={`/${lang}/order`} />
            <p className="sf-hint">{t.signInOptional}</p>
          </>
        ) : (
          <p className="text-sf-ink-2">{t.signInOptional}</p>
        )}
      </section>

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
