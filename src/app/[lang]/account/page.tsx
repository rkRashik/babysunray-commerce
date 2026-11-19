import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireShop } from "@/app/_shop/access";
import { CustomerSignOutButton, GoogleSignInButton } from "@/app/admin/storefront-preview/_components/customer-auth";
import { getDb } from "@/db/client";
import { customerHasPassword } from "@/modules/customers/orders";
import { currentCustomer, customerSignInMethods } from "@/modules/customers/server";
import { dictionary, isLang } from "@/modules/storefront/i18n";
import { AccountForms, ManageAccount } from "./account-forms";

// The customer's account (ADR-0012): sign in, create an account or reset a password; when signed in, the name, the password
// and a link to the orders. Optional: guest checkout never needs an account. Orders placed before signing in stay guest
// orders (followed with their tracking links); an account never claims them by email or phone.
export default async function AccountPage({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  await requireShop();
  const t = dictionary(lang);
  const query = await searchParams;
  const customer = await currentCustomer(await headers()).catch(() => null);
  const methods = customerSignInMethods();
  const verified = query.verified === "1";
  return (
    <div className="mx-auto max-w-md space-y-6 pt-2">
      <h1 className="sf-display text-[2.25rem] lg:text-[3rem]">{t.accountTitle}</h1>
      {verified && customer ? (
        <p role="status" className="sf-note font-semibold" data-tone="ok">
          {lang === "bn" ? "ইমেইল নিশ্চিত হয়েছে। আপনি সাইন ইন করেছেন।" : "Your email is confirmed and you are signed in."}
        </p>
      ) : null}
      {customer ? (
        <section className="sf-card space-y-5 p-5" data-testid="account-signed-in">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="font-semibold" data-testid="customer-name">
              {t.signedInAs(customer.name)}
            </p>
            <CustomerSignOutButton lang={lang} />
          </div>
          <ManageAccount lang={lang} name={customer.name} canChangePassword={await customerHasPassword(getDb(), customer.id)} />
          <Link href={`/${lang}/order`} className="sf-btn sf-btn-ink w-full">
            {t.myOrders}
          </Link>
        </section>
      ) : methods.email || methods.google ? (
        <section className="sf-card space-y-5 p-5">
          <p className="sf-hint">{t.signInOptional}</p>
          {methods.email ? <AccountForms lang={lang} /> : null}
          {methods.google ? <GoogleSignInButton lang={lang} returnTo={`/${lang}/account`} className="w-full" /> : null}
        </section>
      ) : (
        <p className="sf-card p-5">{t.signInUnavailable}</p>
      )}
    </div>
  );
}
