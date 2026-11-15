import type { Metadata } from "next";
import { installationIdentity } from "@/config/installation";
import "./globals.css";

// The installation's own name (src/config/installation.ts), never another business's.
export function generateMetadata(): Metadata {
  return { title: `${installationIdentity().storeName} (development build)`, robots: { index: false, follow: false } };
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
