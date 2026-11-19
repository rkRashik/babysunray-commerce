import { notFound } from "next/navigation";
import { requireShop } from "@/app/_shop/access";
import { isLang } from "@/modules/storefront/i18n";
import { ResetPasswordForm } from "../account-forms";

// Where the password-reset email's link lands (Better Auth adds ?token=…, or ?error=… when the link is invalid or expired).
export default async function ResetPage({ params, searchParams }: { params: Promise<{ lang: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { lang } = await params;
  if (!isLang(lang)) notFound();
  await requireShop();
  const { token } = await searchParams;
  const valid = typeof token === "string" && /^[A-Za-z0-9_-]{8,256}$/.test(token) ? token : null;
  return (
    <div className="mx-auto max-w-md space-y-6 pt-2">
      <h1 className="sf-display text-[2.25rem]">{lang === "bn" ? "নতুন পাসওয়ার্ড" : "Set a new password"}</h1>
      <ResetPasswordForm lang={lang} token={valid} />
    </div>
  );
}
