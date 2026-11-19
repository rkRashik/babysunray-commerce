import { redirect } from "next/navigation";
import { authSettingProblems } from "@/modules/auth/settings";
import { BrandLogo } from "@/app/_design/brand";
import { currentStoreIdentity } from "@/app/_design/identity";
import Link from "next/link";
import { getDb } from "@/db/client";
import { setupState } from "@/modules/auth/setup";
import { SignInForm } from "../_components/auth-forms";
import { adminSurface } from "../_components/shell";
import { currentPrincipal } from "../_lib/session";

export const metadata = { title: "Sign in · Admin" };

export default async function LoginPage() {
  const problems = authSettingProblems(process.env);
  if (problems.length === 0 && (await currentPrincipal())) redirect("/admin");
  const identity = await currentStoreIdentity();
  // A fresh installation has no Owner yet: the first one is created in setup.
  const state = problems.length === 0 ? await setupState(getDb()).catch(() => null) : null;
  if (state && !state.ownerExists) redirect("/admin/setup");
  return (
    <main className={`${adminSurface} flex min-h-screen flex-col items-center justify-center gap-8 px-4 py-10`}>
      <BrandLogo name={identity.storeName} logo={identity.logo} height={52} textClassName="text-[2.25rem]" />
      <div className="of-card w-full max-w-sm space-y-5 p-6 shadow-[0_10px_28px_rgb(51_41_35/0.09)] sm:p-8">
        <h1 className="text-[1.375rem] font-bold">Admin sign-in</h1>
        {problems.length === 0 ? <SignInForm /> : <NotConfigured problems={problems} />}
        {problems.length === 0 ? (
          <Link href="/admin/recover" className="inline-flex min-h-11 items-center text-sm font-semibold underline underline-offset-4">
            Forgot password?
          </Link>
        ) : null}
      </div>
    </main>
  );
}

// Sign-in cannot work until the server's settings are fixed. Outside production the page says which variable
// and rule (never a value), so the operator knows what to change; in production it stays generic.
function NotConfigured({ problems }: { problems: { name: string; problem: string }[] }) {
  if (process.env.NODE_ENV === "production") {
    return (
      <p role="alert" className="text-sm">
        Sign-in is not available right now. The site&apos;s operator needs to check its configuration.
      </p>
    );
  }
  return (
    <div role="alert" className="space-y-2 text-sm">
      <p className="font-medium">Sign-in is not set up on this server yet.</p>
      <ul className="list-disc space-y-1 pl-5">
        {problems.map((p) => (
          <li key={p.name}>{p.problem}</li>
        ))}
      </ul>
      <p>
        Fix it in <code>.env.local</code>, restart <code>npm run dev</code>, and run <code>npm run config:check</code> to see every setting. No account is created or changed by
        this check.
      </p>
    </div>
  );
}
