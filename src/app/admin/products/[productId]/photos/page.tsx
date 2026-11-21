import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { getProductWithVariants } from "@/modules/catalogue/service";
import { DomainError } from "@/modules/domain-error";
import { IMAGE_BOUNDS, IMAGE_PROBLEMS, type ImageProblem } from "@/modules/media/images";
import { MAX_PRODUCT_PHOTOS } from "@/modules/media/service";
import { mediaStoreConfig } from "@/modules/media/storage";
import { ActionForm, Checkbox, Field } from "../../../_components/action-form";
import { LanguageStatus } from "../../../_components/content";
import { FilePicker, UploadButton } from "../../../_components/file-picker";
import { noticeFor, AdminShell, Section, productTitle } from "../../../_components/shell";
import { describePhotoAction, movePhotoAction, removePhotoAction } from "../../../content-actions";
import { requireAdmin } from "../../../_lib/session";

export const metadata = { title: "Photos · Admin" };

type Props = { params: Promise<{ productId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const UPLOAD_ERRORS: Record<string, string> = {
  ...Object.fromEntries((Object.keys(IMAGE_PROBLEMS) as ImageProblem[]).map((k) => [k, `The photo ${IMAGE_PROBLEMS[k]}. Nothing was saved.`])),
  conflict: "The product changed after you loaded this page (another tab?). Nothing was saved: check the photos below and try again.",
  archived: "This product is archived, so its photos cannot change.",
  missing: "That photo no longer exists. Nothing was saved.",
  storage: "Photo storage is not set up on this server (MEDIA_STORAGE_DIR). Nothing was saved; see the runbook.",
  resubmitted: "This form was already sent with a different file. Reload the page to upload another photo.",
  invalid: "The upload could not be read. Nothing was saved.",
  failed: "Something went wrong and nothing was saved. Please try again.",
};

const INPUT = "of-input mt-1.5";
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

/** A plain multipart form to the upload route (works without JavaScript; the server renders the key). */
function UploadForm({ productId, version, replaceMediaId, label }: { productId: string; version: number; replaceMediaId?: string; label: string }) {
  const id = replaceMediaId ?? "new";
  return (
    <form method="post" action={`/admin/products/${productId}/photos/upload`} encType="multipart/form-data" className="space-y-3">
      <input type="hidden" name="idempotencyKey" value={randomUUID()} />
      <input type="hidden" name="version" value={String(version)} />
      {replaceMediaId ? <input type="hidden" name="replaceMediaId" value={replaceMediaId} /> : null}
      <FilePicker
        name="image"
        label={label}
        hint={`JPEG, PNG or WebP, up to 10 MB, ${IMAGE_BOUNDS.minSide} to ${IMAGE_BOUNDS.maxSide} pixels on each side.`}
        accept={PHOTO_TYPES.join(",")}
        types={PHOTO_TYPES}
        maxBytes={10 * 1024 * 1024}
        preview
        required
      />
      <p className="text-xs text-gray-600">
        Use only your own photos of this product. The location and camera details in the file are removed; the photo is stored at most {IMAGE_BOUNDS.storedMaxSide} pixels wide or
        high. Keep your original.
      </p>
      {replaceMediaId ? null : (
        <>
          <div>
            <label htmlFor={`alt-en-${id}`} className="block text-sm font-semibold">What the photo shows (English)</label>
            <input id={`alt-en-${id}`} name="altEn" maxLength={300} className={INPUT} />
          </div>
          <div>
            <label htmlFor={`alt-bn-${id}`} className="block text-sm font-semibold">What the photo shows (Bangla)</label>
            <input id={`alt-bn-${id}`} name="altBn" maxLength={300} lang="bn" className={INPUT} />
          </div>
        </>
      )}
      <UploadButton label={replaceMediaId ? "Replace photo" : "Upload photo"} busyLabel="Uploading…" />
    </form>
  );
}

export default async function PhotosPage({ params, searchParams }: Props) {
  await requireAdmin("catalog:read");
  const { productId } = await params;
  const product = await getProductWithVariants(getDb(), productId).catch((error: unknown) => {
    if (error instanceof DomainError && (error.code === "PRODUCT_NOT_FOUND" || error.code === "INVALID_INPUT")) notFound();
    throw error;
  });
  const { done, error } = await searchParams;
  const storage = mediaStoreConfig(process.env, process.cwd());
  const draft = product.status === "draft";
  const { title, lang } = productTitle(product);
  const back = `/admin/products/${product.id}`;
  const crumbs = [
    { href: "/admin", label: "Products" },
    { href: back, label: title, lang },
  ];
  const ref = { productId: product.id, version: String(product.version) };
  const problem = typeof error === "string" ? (UPLOAD_ERRORS[error] ?? UPLOAD_ERRORS.failed) : null;

  return (
    <AdminShell title="Photos" breadcrumbs={crumbs} notice={noticeFor(done)}>
      {problem ? (
        <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">
          {problem}
        </p>
      ) : null}
      {!storage.ok ? (
        <p role="status" className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-950">
          Photos cannot be stored or shown on this server: {storage.problem} Product photos are kept outside the project in a folder you choose (runbook, Product photos).
        </p>
      ) : null}

      <Section title={`Photos (${product.media.length} of at most ${MAX_PRODUCT_PHOTOS})`}>
        {product.media.length === 0 ? <p className="text-sm text-gray-700">No photos yet. The first photo is the one lists show.</p> : null}
        <ol className="space-y-4" aria-label="Photos in order">
          {product.media.map((m, i) => (
            <li key={m.id} className="space-y-3 rounded border border-gray-300 p-3" data-testid={`photo-${i}`}>
              <div className="flex flex-wrap items-start gap-3">
                {/* Private photos come from the Owner-only media route; Next.js image optimisation would fetch them without the session. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/admin/media/${m.id}?w=320`}
                  alt={m.altEn ?? `Photo ${i + 1} (no English description yet)`}
                  width={160}
                  height={Math.round((160 * m.height) / m.width)}
                  className="rounded border border-gray-300 bg-gray-100"
                />
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                  <dt className="text-gray-600">Position</dt>
                  <dd>{i + 1}{i === 0 ? " (shown first)" : ""}</dd>
                  <dt className="text-gray-600">Stored</dt>
                  <dd>
                    {m.contentType.replace("image/", "").toUpperCase()}, {m.width} × {m.height} px, {Math.ceil(m.byteSize / 1024)} KB
                  </dd>
                  <dt className="text-gray-600">Descriptions</dt>
                  <dd>
                    <LanguageStatus en={m.altEn} bn={m.altBn} />
                  </dd>
                </dl>
              </div>
              {draft ? (
                <>
                  <ActionForm action={describePhotoAction} idempotencyKey={randomUUID()} hidden={{ ...ref, mediaId: m.id }} submitLabel="Save descriptions" variant="secondary">
                    <Field name="altEn" label="What the photo shows (English)" maxLength={300} defaultValue={m.altEn ?? ""} />
                    <Field name="altBn" label="What the photo shows (Bangla)" maxLength={300} lang="bn" defaultValue={m.altBn ?? ""} />
                  </ActionForm>
                  <div className="flex flex-wrap gap-2">
                    {i > 0 ? (
                      <>
                        <ActionForm action={movePhotoAction} idempotencyKey={randomUUID()} hidden={{ ...ref, mediaId: m.id, direction: "first" }} submitLabel={`Show photo ${i + 1} first`} variant="secondary" />
                        <ActionForm action={movePhotoAction} idempotencyKey={randomUUID()} hidden={{ ...ref, mediaId: m.id, direction: "up" }} submitLabel={`Move photo ${i + 1} up`} variant="secondary" />
                      </>
                    ) : null}
                    {i < product.media.length - 1 ? (
                      <ActionForm action={movePhotoAction} idempotencyKey={randomUUID()} hidden={{ ...ref, mediaId: m.id, direction: "down" }} submitLabel={`Move photo ${i + 1} down`} variant="secondary" />
                    ) : null}
                  </div>
                  {storage.ok ? (
                    <details className="rounded border border-gray-200 p-2">
                      <summary className="cursor-pointer text-sm">Replace photo {i + 1}</summary>
                      <UploadForm productId={product.id} version={product.version} replaceMediaId={m.id} label="New photo" />
                    </details>
                  ) : null}
                  <ActionForm
                    action={removePhotoAction}
                    idempotencyKey={randomUUID()}
                    hidden={{ ...ref, mediaId: m.id }}
                    submitLabel={`Remove photo ${i + 1}`}
                    variant="secondary"
                    confirm="Remove this photo? Its stored file is deleted and cannot be brought back here. Keep your own original."
                  >
                    <Checkbox name="confirmRemove" label={`Yes, remove photo ${i + 1} and delete its stored file`} />
                  </ActionForm>
                </>
              ) : null}
            </li>
          ))}
        </ol>
      </Section>

      {draft && storage.ok && product.media.length < MAX_PRODUCT_PHOTOS ? (
        <Section title="Add a photo">
          <UploadForm productId={product.id} version={product.version} label="Photo" />
        </Section>
      ) : null}
      {!draft ? <p className="text-sm text-gray-700">This product is archived, so its photos cannot change.</p> : null}
      <Link href={back} className="inline-flex min-h-11 items-center text-sm underline lg:min-h-0">
        Back to the product
      </Link>
    </AdminShell>
  );
}
