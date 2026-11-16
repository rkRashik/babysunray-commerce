# Public-release privacy audit

**Status:** Private — for the founder only; not for publication. Do not copy this file into any public repository.
**Purpose:** What in this repository and its Git history would be disclosed if any part of it were made public, and how to present the work publicly without that.

Audit date: 2026-11-16, at commit `9a21fc6` plus the documentation changes of Gate H.29. Read-only: nothing was deleted, rewritten or made public. This report names files and kinds of information, never the values themselves.

## Method and limits

- Every tracked file at HEAD, and every blob in all commits (`git rev-list --all`, 43 commits at the time), searched with patterns for credentials (database URLs with passwords, auth secrets, private keys, cloud and chat tokens), e-mail addresses, Bangladesh phone numbers and business terms; commit metadata and messages read; deleted and renamed files listed.
- Pattern search is not proof. No dedicated secret scanner was run, and matched credential values were not displayed or inspected one by one.

## Findings

| # | Finding | Where | Visible after deleting the file? |
|---|---|---|---|
| 1 | The author and committer name and personal e-mail address of every commit | Git metadata of all commits | Yes: history |
| 2 | AI-assistance attribution: `Co-Authored-By` trailers naming an AI model in 9 commits, and further commit messages that mention it | Commit messages | Yes: history |
| 3 | AI tool configuration and working instructions, which also describe the business, its decisions and the private repository | `CLAUDE.md`, `.claude/rules/*`, `.claude/settings.json` (tracked) | Yes: history |
| 4 | Internal business records: budget limits, launch timing, ownership of the domain, the order of internal approvals and gates, open founder decisions, and the location of private source documents | `docs/product/requirements.md` | Yes: history |
| 5 | Approved operational rules not yet published as customer policy (verification, cancellation, returns, refund channels and timelines, RTO handling) | `docs/product/order-policy-decisions.md`, `src/modules/policies/checklist.ts`, parts of `docs/operations/launch-readiness.md` | Yes: history |
| 6 | Launch planning, remaining founder decisions, design direction and customer wording awaiting approval | `docs/operations/launch-readiness.md`, `docs/design/storefront-concepts.md`, `docs/product/requirements.md` section 9 | Yes: history |
| 7 | The shop's own identity settings (name and description lines) | `docs/operations/runbook.md` section 2 | Yes: history |
| 8 | Outage procedures and blank business sheets | `docs/operations/offline-templates.md`, runbook section 9 | Yes: history |
| 9 | Example mobile number in interface hints and messages that follows a real numbering pattern and could belong to a real subscriber | `src/modules/storefront/i18n.ts`, `src/modules/orders/rules.ts`, `src/app/office/orders/new/page.tsx` | Yes: history |
| 10 | Brand name throughout code, database names and configuration (public anyway, but relevant to the reuse goal) | Many files | Yes |

Not found: real customer data, real phone numbers or addresses in fixtures (tests use reserved `example.test` domains and fictional numbers), private keys, API tokens, auth secrets or `.env` files in any commit. Database URLs with a password field appear only in `.env.example` (placeholders) and in test files (fictional values for the connection-guard tests). One file was deleted in history (`src/config/brand.ts`); it held no contact details. Every earlier version of every file, including earlier wording of the business records above, remains in history.

## Recommendations

1. **Keep this repository private** as the working repository. Do not change its visibility: making it public would publish the full history, and deleting a file today does not remove it from earlier commits.
2. **Publish a separate portfolio repository** built from a curated snapshot with no shared history: export a chosen commit (`git archive`), remove the items below, create a new repository with one initial commit under a portfolio or no-reply identity. No history rewrite of this repository is needed.
3. **Leave out of the public copy:** `CLAUDE.md`, `.claude/`, `docs/product/`, `docs/design/`, `docs/private/`, `docs/operations/launch-readiness.md`, `docs/operations/offline-templates.md` and `src/modules/policies/checklist.ts`, or replace them with neutral summaries. Review runbook section 2 and replace the example mobile number with a clearly fictional one.
4. **Decide** whether the public copy keeps the brand name or uses a neutral one, whether AI assistance is disclosed, and which licence (if any) the public copy carries. Without a licence file no reuse rights are granted.
5. **Before publishing:** run a dedicated secret scanner over the new repository, read every remaining Markdown file once, and check that the README, screenshots and package metadata contain nothing from the findings above.
