# Bulk catalogue import

**Status:** Draft — Founder Review. **Purpose:** The file format and rules of the Owner Office's bulk import of new draft products (Office → Import), for the Owner preparing a file and for a developer changing the import.

Code: `src/modules/catalogue/import-file.ts` (reading), `import-plan.ts` (rows to products), `import-service.ts` (preview and import), routes under `src/app/office/import`. Implemented and tested; the format itself is an engineering proposal, not a founder decision.

## What it does and does not do

| Does | Does not |
|---|---|
| Create new **draft** products and their SKUs, with names, descriptions, fabric, care and size guidance in both languages, a category, the featured flag and a size chart | Change, archive or replace any existing product or SKU (create-only: an existing slug or SKU is an error) |
| Give every new SKU a zero stock balance, as the catalogue always does | Receive stock or write any stock movement |
| Store fabric text as written | Confirm a fabric statement: the Owner confirms each one in the product's edit page, with evidence |
| Create everything in one transaction, or nothing | Publish anything: no product is shown to customers, and no publish action exists |

Updating existing drafts from a file is not built. It needs an explicit identity and version per row and a field-by-field change preview, and is separate work.

## Steps

1. Office → Import → download the XLSX or CSV template (column names only; the XLSX template's second sheet explains each column).
2. Fill one row per SKU. Save as **.xlsx** or **CSV UTF-8** (Excel: Save As → "CSV UTF-8 (Comma delimited)").
3. Check file. The preview reads the file and the database and **saves nothing**. It lists every problem by row and column, with a downloadable problem list (row, column, problem; cell values are not repeated in it).
4. Fix the file until there are no problems, check it again, then press Import. The server reads the same file again; if anything changed since the preview (the file, a category, or a slug or SKU now taken), nothing is imported and it asks for a new preview.
5. Pressing Import again after a lost answer is safe: the same preview imports once.

## Columns

Column names are matched without regard to case. Unknown, repeated or missing required columns stop the whole file.

| Column | Required | Rule |
|---|---|---|
| `product_slug` | yes | New product's web name: lowercase a–z, digits, single hyphens, at most 100. Rows with the same slug are one product. |
| `name_en`, `name_bn` | one of them on the product's first row | At most 200 characters. |
| `description_en`, `description_bn` | no | At most 5,000; line breaks allowed. |
| `category_slug` | no | An existing category's slug (Office → Categories). |
| `fabric_en`, `fabric_bn`, `care_en`, `care_bn`, `size_guidance_en`, `size_guidance_bn` | no | At most 1,000; line breaks allowed. Fabric is imported **not confirmed**. |
| `featured` | no | `yes` or `no` (empty means no). |
| `sku` | yes | One row per SKU; A–Z, digits, hyphen, underscore, at most 64; stored in capitals; new and unique. |
| `size`, `colour` | no | At most 64. |
| `price_bdt` | yes | Taka greater than 0 with at most two decimals: `850` or `850.50`. No ৳ sign, no thousands separator. Stored exactly as integer paisa. |
| `chest_cm`, `waist_cm`, `hip_cm`, `length_cm`, `shoulder_cm`, `sleeve_cm`, `inseam_cm`, `foot_cm` | no | Centimetres with at most one decimal (0.1 to 300), for the row's `size`. Two rows of one product with the same size must give the same value. |

The product columns (`name_en` to `featured`) are read from a product's **first** row. Later rows of the same product may leave them empty or repeat them exactly; a different value is an error, never a choice.

Fictional example (CSV):

```
product_slug,name_en,name_bn,sku,size,colour,price_bdt,chest_cm
fictional-romper,Fictional Romper,কাল্পনিক রম্পার,FIC-ROMPER-0-3,0-3M,Ivory,850,24.5
fictional-romper,,,FIC-ROMPER-3-6,3-6M,Ivory,850.50,26
```

## Limits and safety

- At most 2 MB, 1,000 rows, 40 columns and 5,000 characters per cell. Empty rows are skipped and counted.
- Text is stored as Unicode NFC; control characters, broken Unicode and line breaks in one-line fields are refused.
- A cell starting with `=`, `+`, `@` or `-` followed by a non-space (after trimming) is refused, so the data cannot become a formula when it is later opened in a spreadsheet (CSV injection).
- XLSX: the first sheet only. A formula cell is refused and its stored result is never used. Macro-enabled, password-protected, ZIP64 and old .xls files are refused. The reader inflates only the parts it needs, each with a size limit (40 MB in total, so a "zip bomb" stops), checks every part's CRC, and refuses XML with a DOCTYPE or ENTITY.
- Owner only (`catalog:write`), session cookie, a POST from the Office's own origin, a byte limit while reading.
- Every import is recorded in `catalogue_imports` (append-only): who, when, the file's SHA-256 (never its content), the format and what it created.
