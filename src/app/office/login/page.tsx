import { redirect } from "next/navigation";
import { authSettingProblems } from "@/modules/auth/settings";
import { SignInForm } from "../_components/auth-forms";
import { currentPrincipal } from "../_lib/session";

export const metadata = { title: "Sign in · Owner Office" };

export default async function LoginPage() {
  const problems = authSettingProblems(process.env);
  if (problems.length === 0 && (await currentPrincipal())) redirect("/office");
  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4 text-gray-900">
      <div className="w-full max-w-sm space-y-4 rounded border border-gray-300 bg-white p-6">
        <h1 className="text-xl font-semibold">Owner Office sign-in</h1>
        {problems.length === 0 ? <SignInForm /> : <NotConfigured problems={problems} />}
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
