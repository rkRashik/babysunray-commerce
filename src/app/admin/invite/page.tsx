import { BrandLogo } from "@/app/_design/brand";
import { adminStoreName, currentStoreIdentity } from "@/app/_design/identity";
import { adminSurface } from "../_components/shell";
import { InviteForm } from "./invite-form";

export const metadata = { title: "Join Admin", robots: { index: false, follow: false }, referrer: "no-referrer" };
export const dynamic = "force-dynamic";

// Accepting a staff invitation, or setting a new password with a link from the Owner (src/modules/auth/staff.ts). No
// session: the one-time link is the credential, checked and rate limited on the server.
export default async function InvitePage() {
  const identity = await currentStoreIdentity();
  return (
    <main className={`${adminSurface} flex min-h-screen flex-col items-center justify-center gap-8 px-4 py-10`}>
      <BrandLogo name={adminStoreName(identity)} logo={identity.logo} height={52} textClassName="text-[2.25rem]" />
      <div className="of-card w-full max-w-md space-y-5 p-6 shadow-[0_10px_28px_rgb(51_41_35/0.09)] sm:p-8">
        <h1 className="text-[1.375rem] font-bold">Your Admin account</h1>
        <InviteForm />
      </div>
    </main>
  );
}
