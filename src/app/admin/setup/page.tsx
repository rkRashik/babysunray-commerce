import Link from "next/link";
import { BrandLogo } from "@/app/_design/brand";
import { currentStoreIdentity } from "@/app/_design/identity";
import { getDb } from "@/db/client";
import { setupGrantConfigured, setupState } from "@/modules/auth/setup";
import { emailAvailable } from "@/modules/email/service";
import { adminSurface } from "../_components/shell";
import { SetupForm } from "./setup-form";

export const metadata = { title: "Set up · Admin" };
export const dynamic = "force-dynamic";

// First-time Admin setup (ADR-0012). Open only on an installation without an active Owner, and only with the setup code
// (ADR-0012: ADMIN_SETUP_TOKEN, set out of band). Afterwards it only says that setup is done.
export default async function SetupPage() {
  const identity = await currentStoreIdentity();
  const state = await setupState(getDb()).catch(() => null);
  const card = "of-card w-full max-w-md space-y-5 p-6 shadow-[0_10px_28px_rgb(51_41_35/0.09)] sm:p-8";
  let body: React.ReactNode;
  if (!state) body = <p role="alert">The database cannot be reached. Check the site&apos;s database settings.</p>;
  else if (state.ownerExists)
    body = (
      <div className="space-y-4" data-testid="setup-closed">
        <p>This store is already set up. Sign in with the Owner account.</p>
        <Link href="/admin/login" className="of-btn of-btn-primary w-full">
          Sign in
        </Link>
      </div>
    );
  else if (!state.schemaReady) body = <p role="alert">The database needs its latest update (migration 0021) before setup. See docs/operations/installation-production.md.</p>;
  else if (!setupGrantConfigured(process.env))
    body = (
      <div className="space-y-3 text-sm" data-testid="setup-locked">
        <p className="font-semibold">Setup is locked.</p>
        <p>
          To prove you own this installation, set <code>ADMIN_SETUP_TOKEN</code> in the site&apos;s environment settings to a long random value (at least 32 characters, for example from a password
          manager), redeploy, and open this page again. You will type the same value here.
        </p>
      </div>
    );
  else body = <SetupForm emailOn={emailAvailable()} />;
  return (
    <main className={`${adminSurface} flex min-h-screen flex-col items-center justify-center gap-8 px-4 py-10`}>
      <BrandLogo name={identity.storeName} logo={identity.logo} height={52} textClassName="text-[2.25rem]" />
      <div className={card}>
        <div>
          <h1 className="text-[1.375rem] font-bold">Set up Admin</h1>
          <p className="text-sm text-gray-700">Create the first Owner account</p>
        </div>
        {body}
      </div>
    </main>
  );
}
