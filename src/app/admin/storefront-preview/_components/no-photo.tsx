import { ImageOff } from "lucide-react";

/** The space of a photo that does not exist (yet): the same shape and ground, a quiet icon and the words. */
export function NoPhoto({ label }: { label: string }) {
  return (
    <div className="sf-no-photo">
      <ImageOff aria-hidden="true" size={22} strokeWidth={1.5} />
      <span>{label}</span>
    </div>
  );
}
