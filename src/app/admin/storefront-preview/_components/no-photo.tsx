import { ImageOff } from "lucide-react";

/**
 * The space of a photo that does not exist (yet): the same shape and ground, a quiet icon and the words. `decorative`
 * where a photo would be decorative too (a product card's link is named by the product's name, so it is read once).
 */
export function NoPhoto({ label, decorative = false }: { label: string; decorative?: boolean }) {
  return (
    <div className="sf-no-photo" aria-hidden={decorative || undefined}>
      <ImageOff aria-hidden="true" size={22} strokeWidth={1.5} />
      <span>{label}</span>
    </div>
  );
}
