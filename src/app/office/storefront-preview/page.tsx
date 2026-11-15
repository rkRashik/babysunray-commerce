import { redirect } from "next/navigation";
import { requireOffice } from "../_lib/session";

// /office/storefront-preview → the English preview (the language switch is on every page).
export default async function PreviewIndex() {
  await requireOffice("storefront:preview");
  redirect("/office/storefront-preview/en");
}
