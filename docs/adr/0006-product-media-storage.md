# ADR-0006: Product photo storage (local development adapter)

**Status:** Draft — Founder Review
**Date:** 2026-11-15
**Deciders:** Founder
**Related:** [Product requirements](../product/requirements.md) (I-5, K-2, RU-2, RU-5; open decisions 1, 14, 15), [ADR-0001](0001-application-stack.md), [runbook](../operations/runbook.md) (Product photos)

**In short:** Batch H.17–H.20 authorised a development-only photo foundation that a future storage provider can replace. Photo files live behind a small storage interface; the only implementation is a local folder outside the repository, refused in production unless explicitly allowed. The database holds a manifest row per photo. Where photos live in production, how they are backed up and how they reach customers are **not** decided.

## Context

Product photos are needed to prepare the catalogue (S-6, I-5), but hosting (decision 1) and the photo workflow (decision 14) are open. A serverless or container host may have no persistent writable disk. Photos are large binary files that must never enter Git or a public folder, and the encrypted database backup does not include files.

## Decision

- **Interface** (`src/modules/media/storage.ts`): `put` (atomic, never overwrites), `read` (regular files only), `remove`, `entries`, `info`. Keys are random (128 bits, hex, with the format's extension) and checked against one pattern before any file-system access, so no user input becomes a path.
- **Local adapter:** the folder in `MEDIA_STORAGE_DIR`, which must be absolute, exist and lie outside the project folder. Under `NODE_ENV=production` it is refused unless `MEDIA_LOCAL_STORAGE_IN_PRODUCTION=allow`; setting that is a deployment decision for a persistent, backed-up disk. The production browser tests set it for a throwaway local folder.
- **Processing** (`src/modules/media/images.ts`, `sharp`): the type comes from the file's bytes; only JPEG, PNG and WebP; the image is fully decoded, re-encoded in the same format without metadata and stored at most 2,400 pixels a side. The original upload is not kept.
- **Manifest:** `product_media` (migration 0011) records product, key, type, byte size, dimensions, SHA-256, alt text, position and times. `npm run media:verify` compares it with the folder; the Exports page exports it.
- **Consistency:** a file is written before its record and deleted if the record is not committed; a removed or replaced file is deleted after its record. A crash can leave a file without a record (reported, never deleted automatically), never a record without its file from this code path.
- **Access:** files are served only through `/office/media/{id}` to a signed-in Owner (`catalog:read`), with `private, no-cache`, an ETag, `nosniff` and a sandbox policy. No public URL exists. Resized copies are kept in process memory (32 MB, least recently used out, keyed by SHA-256 and width) and at most two image decodes or resizes run at once (Gate H.22).
- **Links and folders:** the photo folder's real path must be outside the project; a link or folder under a photo's name is never read as a photo and is reported as unexpected.
- **Photo backups (Gate H.22):** `npm run media:backup` seals the recorded photos and their manifest with the database backup's own construction (`src/db/backup.mts`, a separate format name), only when the folder and the records are consistent before and after reading; `media:backup:verify` and `media:restore` (into an empty folder only) complete the cycle, rehearsed by `npm run media:drill`. The database and photo backups remain two files taken at two moments; `media:verify` reports any difference after a restore.

## Consequences

- Replacing the local folder with object storage later means a second implementation of the interface and a copy of the files listed in the manifest; the catalogue code does not change.
- Database backups and photo files are separate: restoring the system needs both, checked with `media:verify`.
- `sharp` (Apache-2.0) ships prebuilt libvips binaries under LGPL-3.0-or-later; they must be part of the licence review before any redistribution (RU-5).

## Not decided

Production photo storage and its cost (C-1), a photo CDN or image service, a schedule, retention and an off-device copy for photo backups (K-2, K-4, decision 15), how photos are published to customers, and how many photos a product needs (I-5).
