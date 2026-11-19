import type { Metadata } from "next";
import { currentStoreIdentity } from "@/app/_design/identity";
import "./globals.css";

// The installation's own name (src/config/installation.ts), never another business's.
export async function generateMetadata(): Promise<Metadata> {
  return { title: `${(await currentStoreIdentity()).storeName} (development build)`, robots: { index: false, follow: false } };
}

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
