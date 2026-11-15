import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";

// Fictional test photos, generated in memory (no binary files in the repository), and throwaway media folders
// in the operating system's temporary directory (never inside the project).

/** A plain-colour image; `exif` adds identifying metadata (fictional) that upload must strip. */
export async function testImage(format: "jpeg" | "png" | "webp", width = 400, height = 300, options: { exif?: boolean; colour?: number } = {}): Promise<Buffer> {
  const base = sharp({ create: { width, height, channels: 3, background: { r: options.colour ?? 194, g: 139, b: 86 } } });
  const withMeta = options.exif ? base.withExif({ IFD0: { Artist: "Fictional Photographer", ImageDescription: "fictional-secret-place" } }) : base;
  return withMeta[format]().toBuffer();
}

/** A new empty folder for one test file's media; remove it with the returned function. */
export function tempMediaDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), `bs-media-${prefix}-`));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
