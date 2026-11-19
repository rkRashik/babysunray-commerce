import Link from "next/link";
import { BrandLogo } from "@/app/_design/brand";
import { flFontVariables } from "@/app/_design/fonts";
import { SunMark } from "@/app/_design/sun-mark";
import { currentShopAccess } from "@/app/_shop/access";
import { currentStoreIdentity } from "@/app/_design/identity";

// The site root. While the shop is closed (the public launch gate refuses), a status line in the First Light look and no shop
// content. A browser holding a founder acceptance pass (ADR-0011) also gets the two ways into the shop.
export default async function Page() {
  const { storeName, logo } = await currentStoreIdentity();
  const open = (await currentShopAccess()) !== "closed";
  return (
    <main className={`sf ${flFontVariables} flex min-h-dvh flex-col items-center justify-center gap-6 px-6 py-16 text-center`}>
      <BrandLogo name={storeName} logo={logo} height={56} textClassName="text-[2.5rem]" />
      <SunMark className="h-6 w-10 text-sf-sun" />
      <h1 className="text-[1.5rem]">{storeName}: development build</h1>
      <p className="max-w-md text-sf-ink-2">Engineering scaffold only. This is not the approved homepage and not a live store.</p>
      {open ? (
        <div className="flex flex-wrap justify-center gap-3" data-testid="shop-entry">
          <Link href="/en" className="sf-btn">
            Open the shop
          </Link>
          <Link href="/bn" lang="bn" className="sf-btn sf-btn-ghost">
            দোকান খুলুন
          </Link>
        </div>
      ) : null}
    </main>
  );
}
