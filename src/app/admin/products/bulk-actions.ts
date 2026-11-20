"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/db/client";
import { bulkProducts, type ProductBulkResult } from "@/modules/catalogue/bulk";
import { DomainError } from "@/modules/domain-error";
import { formError, text, wholeNumber } from "../_lib/form";
import { requireAdmin } from "../_lib/session";

export type ProductBulkState = { results?: ProductBulkResult[]; error?: string };

/** Sets the category of, or archives, the selected draft products, each by itself (modules/catalogue/bulk.ts), one result per product. */
export async function bulkProductsAction(_: ProductBulkState, form: FormData): Promise<ProductBulkState> {
  const principal = await requireAdmin("catalog:write");
  try {
    const kind = text(form, "bulkAction");
    if (kind !== "archive" && kind !== "category") throw new DomainError("INVALID_INPUT", "Choose a step for the selected products.");
    const items = form.getAll("product").map((entry) => {
      const [productId, version] = String(entry).split(":");
      return { productId, expectedVersion: wholeNumber(version ?? "", "Version") };
    });
    const categoryId = text(form, "categoryId");
    const action = kind === "archive" ? ({ kind } as const) : ({ kind, categoryId: categoryId === "" ? null : categoryId } as const);
    const results = await bulkProducts(getDb(), principal, text(form, "batch"), action, items);
    revalidatePath("/admin");
    return { results };
  } catch (error) {
    return { error: formError(error, form).error };
  }
}
