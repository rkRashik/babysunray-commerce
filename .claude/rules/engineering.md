---
paths:
  - "src/**/*"
  - "tests/**/*"
  - "scripts/**/*"
  - "drizzle/**/*"
  - "prisma/**/*"
---

# Engineering rules

## TypeScript

- `strict` mode stays on. No `any`, no `@ts-ignore`; if a type is genuinely unknown, use `unknown` and narrow it.
- Validate every external input (form data, query strings, request bodies, environment variables) at the boundary where it enters, then pass typed values inward.
- Prefer plain functions and data over classes. Name things after the business concept (`reserveStock`, not `handleData`).

## Module boundaries

- Route files under `src/app/` parse input, call a domain module, and render. They contain no business rules and no direct database queries.
- Each domain module (catalogue, inventory, orders, customers, reports, auth) owns its rules and its data access, and exposes a small public surface. Other modules use that surface, not its internals.
- Components display state and collect input. Pricing, stock, status transitions and permission decisions are made on the server in domain modules.
- Mark server-only modules so they cannot be imported into client components.

## Simplicity

- Write the smallest change that fully meets the requirement. No speculative options, wrappers, generic frameworks or "for later" code.
- Add a dependency only when it clearly beats a few lines of code. Name it and the reason in the change summary. Never add one without founder approval while package installation needs approval.
- Reuse what the codebase already has before writing something new.

## Data integrity

- Money is integer paisa. Never floating point.
- Store timestamps in UTC; display in Asia/Dhaka.
- Phone numbers and order identifiers are strings.
- Stock changes, order creation and status transitions run inside database transactions. Check affected-row counts; a conditional update that changes zero rows is a failure, not a success.
- Order submission is idempotent.
- Lifecycle dimensions (order, fulfilment, payment, return/refund) are separate fields. Order source is an attribute, not a status.
- Do not implement logic that depends on business rules still marked **Q** in the requirements (for example O-9 to O-14). Stop and ask.
- Schema changes go through migrations, never manual edits to a shared database.

## Tests

- Rules touching money, stock, orders, exports or access control get automated tests, including the failure cases (last unit, retry, unauthorised user).
- Tests use fictional data only.
- A test that cannot fail is not a test. Check that a new test fails without the change when practical.
