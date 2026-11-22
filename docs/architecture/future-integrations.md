# Future integrations: courier APIs, WhatsApp notifications and payment gateways

**Status:** Draft — Founder Review
**Purpose:** What a later gate would need before connecting a courier, official WhatsApp messages or a payment gateway. None of these is built; nothing in the shop or Admin claims otherwise.

Today the Owner records delivery, COD collection and settlement by hand ([order-policy-decisions.md](../product/order-policy-decisions.md)), contacts customers by phone, Messenger or WhatsApp from the order page, and verifies manual advance payments in their own account ([ADR-0013](../adr/0013-staff-access-and-manual-payments.md)). Those records stay the source of truth whatever is connected later.

## Courier platforms (for example Pathao, Steadfast)

| Needed | Why |
|---|---|
| A merchant account and API eligibility with the courier, and its written API terms | Most courier APIs are offered per merchant, after approval. |
| Consignment creation from a packed order (weight, COD amount = amount still due, address, phone) | Sends customer data to a third party: needs the privacy policy to say so (S-17). |
| The courier's tracking identifier stored on the order | Shown to the Owner; to the customer only if the founder approves. |
| Status updates by signed webhook or by polling, with replay protection | A webhook is a new public endpoint: it needs a gate, signature checks and a rate limit. |
| A mapping from the courier's statuses to dispatched, delivered and RTO | Automatic transitions must still follow the order rules (rule L, RTO quarantine). |
| Failure and retry handling (courier down, duplicate consignment) | Idempotent, like every other write (ADR-0005). |
| RTO and COD reconciliation against the courier's statements | The read-only statement check exists ([courier-statements.md](../operations/courier-statements.md)); recording from a statement is not built. |
| Permissions (who may create consignments) and audit | A new permission, Owner and Manager only unless decided otherwise. |

Live courier tracking is not promised to customers.

## WhatsApp order notifications

Only the official WhatsApp Business Platform (Cloud API) qualifies. Unofficial automation, browser scripting and personal-account bots are excluded: they break WhatsApp's terms and risk the number.

| Needed | Why |
|---|---|
| Business verification with Meta and a dedicated WhatsApp Business number | Required for API access. |
| Approved message templates (English and Bangla) for each notification | Business-initiated messages outside a 24-hour customer window must use approved templates. |
| Recorded customer consent (opt-in at checkout) | Messaging a customer needs their permission; consent must be stored with the order. |
| Delivery status by signed webhook | A new public endpoint, gated like any other. |
| A budget for per-conversation charges | Meta charges per conversation; amounts are not assumed here. |
| A decision on which events notify (received, confirmed, dispatched) | Never "confirmed" before the Owner confirms (rule B). |

Until then the Admin's order page keeps its call and copy buttons, and the Owner messages customers by hand. WhatsApp automation is not a launch requirement.

## Payment gateways (for example bKash Payment Gateway, Nagad, SSLCommerz)

A gateway would add a payment method whose money is confirmed by the provider's signed callback instead of the Owner's check. The order's `payment_method`, the append-only ledger and the derived payment status (ADR-0013) stay; a gateway adds its merchant agreement, credentials as secrets, a callback endpoint, refunds through the provider, and reconciliation with its settlement reports. Nothing of a gateway exists, and no fake one is simulated.
