import { BrandLogo } from "@/app/_design/brand";
import { currentStoreIdentity } from "@/app/_design/identity";
import { adminSurface } from "../_components/shell";
import { RecoverForm } from "../setup/setup-form";

export const metadata = { title: "Recover access · Admin" };
export const dynamic = "force-dynamic";

// Owner account recovery with a one-time recovery code (src/modules/auth/setup.ts). Rate limited; ends every old session.
export default async function RecoverPage() {
  const identity = await currentStoreIdentity();
  return (
    <main className={`${adminSurface} flex min-h-screen flex-col items-center justify-center gap-8 px-4 py-10`}>
      <BrandLogo name={identity.storeName} logo={identity.logo} height={52} textClassName="text-[2.25rem]" />
      <div className="of-card w-full max-w-md space-y-5 p-6 shadow-[0_10px_28px_rgb(51_41_35/0.09)] sm:p-8">
        <div>
          <h1 className="text-[1.375rem] font-bold">Forgot password</h1>
          <p className="text-sm text-gray-700">Use one of your recovery codes · রিকভারি কোড দিয়ে নতুন পাসওয়ার্ড দিন</p>
        </div>
        <RecoverForm />
      </div>
    </main>
  );
}
