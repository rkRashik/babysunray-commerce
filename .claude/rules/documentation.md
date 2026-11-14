---
paths:
  - "**/*.md"
---

# Documentation rules

## Status

- Every authoritative document starts with a status line: `Draft`, `Draft — Founder Review`, `Approved (YYYY-MM-DD)`, or `Superseded by <link>`, followed by a one-line purpose.
- Only the founder approves. Never change a status to Approved on your own.
- An approved ADR is not edited. A change is a new ADR that supersedes it; mark the old one Superseded.
- ADRs are for material architectural decisions (hosting, database, ORM, authentication). Minor choices are recorded in development documentation or the change that makes them.

## One source of truth

- Each subject has one authoritative document. Others link to it instead of restating it.
- Requirements live in `docs/product/requirements.md`, architecture decisions in `docs/adr/`. Do not copy requirement text into README, CLAUDE.md or code comments.
- Keep requirement IDs stable. Add new IDs; do not renumber.
- Preserve the basis labels (F, P, F + P, Q). Do not upgrade P or Q to F.

## Keeping documents current

- When code changes behaviour that a document describes, update the document in the same change.
- When a document turns out to be wrong or contradicted, report it rather than silently choosing a side.
- Do not create empty or placeholder documents. Create a document when there is real content for it.

## Writing

- Write for a developer or the founder reading it later: plain language, short sections, tables where they help.
- State facts that were verified and mark what was not. Never present an assumption, plan or proposal as fact.
- No session logs, AI review reports, generic best-practice filler or marketing language in the repository.
- Do not include customer data, secrets, private business figures or supplier contacts.
