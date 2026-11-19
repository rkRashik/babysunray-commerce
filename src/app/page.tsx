import { BrandLogo } from "@/app/_design/brand";
import { flFontVariables } from "@/app/_design/fonts";
import { SunMark } from "@/app/_design/sun-mark";
import { installationIdentity } from "@/config/installation";

// The site root while the shop is closed: a status line in the First Light look, no shop content (the launch gate refuses).
export default function Page() {
  const { storeName } = installationIdentity();
  return (
    <main className={`sf ${flFontVariables} flex min-h-dvh flex-col items-center justify-center gap-6 px-6 py-16 text-center`}>
      <BrandLogo name={storeName} height={56} textClassName="text-[2.5rem]" />
      <SunMark className="h-6 w-10 text-sf-sun" />
      <h1 className="text-[1.5rem]">{storeName}: development build</h1>
      <p className="max-w-md text-sf-ink-2">Engineering scaffold only. This is not the approved homepage and not a live store.</p>
    </main>
  );
}
