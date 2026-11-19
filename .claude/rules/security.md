---
paths:
  - "src/**/*"
  - "tests/**/*"
  - "scripts/**/*"
  - "drizzle/**/*"
  - "prisma/**/*"
  - "/.env.example"
  - "/.gitignore"
  - ".claude/settings.json"
---

# Security rules

## Authentication and authorisation

- Every Admin page, server action, route handler and export is protected **on the server**. Hiding a link or button is not access control.
- Check authorisation in the domain module or handler that performs the action, not only in middleware or layout.
- Each protected route and action gets a negative test (anonymous and unauthorised requests are rejected).
- Use the authentication solution the founder approves. Do not write a custom authentication or session protocol.
- State-changing requests are protected against CSRF.

## Personal data and secrets

- Customer names, phone numbers and addresses never appear in logs, URLs, query strings, analytics, error reports, commit messages or test fixtures.
- Tracking links are credentials: never log them, never send them to third parties, send no referrer from the tracking page, and keep it uncached and unindexed.
- Secrets live only in environment variables. Never read, print, echo or commit `.env` files or keys. `.env.example` contains variable names and safe placeholders only.
- Error messages shown to users are generic; details go to server logs without personal data.

## Exports, backups and money

- Exports containing personal data are owner-only, logged with actor and time, and served from non-public, non-predictable locations.
- Prevent spreadsheet formula injection in CSV and XLSX output.
- Backups and exports never go into the repository, a public folder or a URL.
- Financial operations (COD amounts, settlements, refunds, adjustments) are recorded with who and when, and are never silently edited or deleted.

## Honesty about security

- Do not describe anything as secure, encrypted, backed up or restorable unless a test or drill in this repository shows it. Say what was tested and what was not.
- Claude Code permission rules are not a sandbox. Do not rely on them to protect secrets; keep secrets out of the working tree where possible.
