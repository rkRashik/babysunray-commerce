"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/db/client";
import { MEASUREMENT_POINTS, parseCentimetres } from "@/modules/catalogue/content";
import { createCategoryOnce, replaceMeasurementsOnce, updateCategoryOnce } from "@/modules/catalogue/operations";
import { DomainError } from "@/modules/domain-error";
import { removeUnreferencedFiles } from "@/modules/media/manifest";
import { describePhotoOnce, movePhotoOnce, removePhotoOnce } from "@/modules/media/operations";
import { getMediaStore } from "@/modules/media/provider";
import { formError, type FormState, optional, text, wholeNumber } from "./_lib/form";
import { MEASUREMENT_LABELS } from "./_lib/labels";
import { requireAdmin } from "./_lib/session";

// Admin Server Actions for product content: the size chart, categories and photo management (uploads
// go through a route handler, src/app/admin/products/[productId]/photos/upload, because files are large).
// Same rules as actions.ts: each checks the session and permission itself and calls the shared operation.

/** The size chart form: hidden `size<i>` per row and `m<i><point>` cells in centimetres; an empty cell is no value. */
export async function replaceMeasurementsAction(_: FormState, form: FormData): Promise<FormState> {
  const principal = await requireAdmin("catalog:write");
  const productId = text(form, "productId");
  try {
    const rows = wholeNumber(text(form, "rows"), "Rows");
    const measurements = [];
    for (let i = 0; i < Math.min(rows, 60); i += 1) {
      const size = text(form, `size${i}`);
      for (const point of MEASUREMENT_POINTS) {
        const raw = text(form, `m${i}${point}`).trim();
        if (raw === "") continue;
        try {
          measurements.push({ size, point, valueMm: parseCentimetres(raw) });
        } catch {
          throw new DomainError("INVALID_INPUT", `${MEASUREMENT_LABELS[point]} for size ${size} must be centimetres with at most one decimal, from 0.1 to 300 (for example 42 or 42.5).`);
        }
      }
    }
    await replaceMeasurementsOnce(getDb(), principal, text(form, "idempotencyKey"), { productId, expectedVersion: wholeNumber(text(form, "version"), "Version"), measurements });
  } catch (error) {
    return formError(error, form);
  }
  redirect(`/admin/products/${productId}?done=measurements-saved`);
}

export async function createCategoryAction(_: FormState, form: FormData): Promise<FormState> {
  const principal = await requireAdmin("catalog:write");
  try {
    await createCategoryOnce(getDb(), principal, text(form, "idempotencyKey"), { slug: text(form, "slug"), nameEn: optional(form, "nameEn"), nameBn: optional(form, "nameBn") });
  } catch (error) {
    return formError(error, form);
  }
  redirect("/admin/categories?done=category-created");
}

export async function updateCategoryAction(_: FormState, form: FormData): Promise<FormState> {
  const principal = await requireAdmin("catalog:write");
  try {
    await updateCategoryOnce(getDb(), principal, text(form, "idempotencyKey"), {
      categoryId: text(form, "categoryId"),
      expectedVersion: wholeNumber(text(form, "version"), "Version"),
      nameEn: optional(form, "nameEn"),
      nameBn: optional(form, "nameBn"),
    });
  } catch (error) {
    return formError(error, form);
  }
  redirect("/admin/categories?done=category-updated");
}

const photosPage = (productId: string, done: string) => `/admin/products/${productId}/photos?done=${done}`;

export async function describePhotoAction(_: FormState, form: FormData): Promise<FormState> {
  const principal = await requireAdmin("catalog:write");
  const productId = text(form, "productId");
  try {
    await describePhotoOnce(getDb(), principal, text(form, "idempotencyKey"), {
      productId,
      mediaId: text(form, "mediaId"),
      expectedVersion: wholeNumber(text(form, "version"), "Version"),
      altEn: optional(form, "altEn"),
      altBn: optional(form, "altBn"),
    });
  } catch (error) {
    return formError(error, form);
  }
  redirect(photosPage(productId, "photo-described"));
}

export async function movePhotoAction(_: FormState, form: FormData): Promise<FormState> {
  const principal = await requireAdmin("catalog:write");
  const productId = text(form, "productId");
  const direction = text(form, "direction");
  try {
    if (direction !== "up" && direction !== "down" && direction !== "first") throw new DomainError("INVALID_INPUT", "Choose where to move the photo.");
    await movePhotoOnce(getDb(), principal, text(form, "idempotencyKey"), { productId, mediaId: text(form, "mediaId"), expectedVersion: wholeNumber(text(form, "version"), "Version"), direction });
  } catch (error) {
    return formError(error, form);
  }
  redirect(photosPage(productId, "photo-moved"));
}

/** Removing a photo deletes its stored file, so the form must carry an explicit tick as well as the dialog. */
export async function removePhotoAction(_: FormState, form: FormData): Promise<FormState> {
  const principal = await requireAdmin("catalog:write");
  const productId = text(form, "productId");
  try {
    if (text(form, "confirmRemove") !== "on") throw new DomainError("INVALID_INPUT", "Tick the box to confirm that this photo and its stored file should be removed.");
    await removePhotoOnce(getDb(), principal, text(form, "idempotencyKey"), { productId, mediaId: text(form, "mediaId"), expectedVersion: wholeNumber(text(form, "version"), "Version") });
  } catch (error) {
    return formError(error, form);
  }
  redirect(photosPage(productId, "photo-removed"));
}

/** Deletes photo files no record uses (older than an hour), after an explicit tick. Never automatic. */
export async function removeUnreferencedAction(_: FormState, form: FormData): Promise<FormState> {
  const principal = await requireAdmin("catalog:write");
  let removed = 0;
  try {
    if (text(form, "confirmCleanup") !== "on") throw new DomainError("INVALID_INPUT", "Tick the box to confirm that these files should be deleted.");
    removed = (await removeUnreferencedFiles(getDb(), principal, getMediaStore())).removed.length;
  } catch (error) {
    return formError(error, form);
  }
  redirect(`/admin/media-health?done=cleanup&removed=${removed}`);
}
