import "server-only";
import { closeSync, openSync, readSync } from "node:fs";
import path from "node:path";

// The installation's own logo, when it has one: public/brand/logo.png (the wordmark) and public/brand/mark.png (the
// compact mark), committed so a Git deployment ships them; a copy for another business deletes or replaces them
// (docs/operations/installation.md). Without the files the shop's name is shown as text, so a copy shows no other
// business's logo. The artwork is shown as supplied: never recoloured, redrawn or animated (BR-3).

type Size = { width: number; height: number };

/** The PNG's pixel size from its header, or null when the file is missing or not a PNG. */
function pngSize(file: string): Size | null {
  let fd: number | null = null;
  try {
    fd = openSync(path.join(process.cwd(), "public", "brand", file), "r");
    const head = Buffer.alloc(24);
    if (readSync(fd, head, 0, 24, 0) < 24 || head.toString("latin1", 1, 4) !== "PNG") return null;
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** The wordmark at a given height, or the shop's name as text. */
export function BrandLogo({ name, height, logo, className = "", textClassName = "" }: { name: string; height: number; logo?: { src: string; width: number; height: number } | null; className?: string; textClassName?: string }) {
  // The logo the Owner uploaded in Admin settings comes first.
  if (logo) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={logo.src} alt={name} width={Math.round((logo.width / logo.height) * height)} height={height} className={`block h-auto max-w-full ${className}`} decoding="async" fetchPriority="high" />;
  }
  const size = pngSize("logo.png");
  if (!size) return <span className={`fl-wordmark ${textClassName}`}>{name}</span>;
  return (
    // A small static file; next/image would add a client runtime for nothing.
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/brand/logo.png" alt={name} width={Math.round((size.width / size.height) * height)} height={height} className={`block h-auto max-w-full ${className}`} decoding="async" fetchPriority="high" />
  );
}

/** The compact mark in a square, or the name's first letter. Decorative when `label` is empty. */
export function BrandMark({ name, size, className = "" }: { name: string; size: number; className?: string }) {
  const file = pngSize("mark.png");
  const style = { width: size, height: size };
  if (!file) {
    return (
      <span aria-hidden="true" style={style} className={`fl-mark-fallback ${className}`}>
        {[...name][0] ?? ""}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/brand/mark.png" alt="" width={size} height={size} style={{ ...style, objectFit: "contain" }} className={className} decoding="async" />
  );
}
