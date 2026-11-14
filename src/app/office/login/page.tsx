import { redirect } from "next/navigation";
import { SignInForm } from "../_components/auth-forms";
import { currentPrincipal } from "../_lib/session";

export const metadata = { title: "Sign in · Owner Office" };

export default async function LoginPage() {
  if (await currentPrincipal()) redirect("/office");
  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4 text-gray-900">
      <div className="w-full max-w-sm space-y-4 rounded border border-gray-300 bg-white p-6">
        <h1 className="text-xl font-semibold">Owner Office sign-in</h1>
        <SignInForm />
      </div>
    </main>
  );
}
