import Link from "next/link";
import { getDb } from "@/db/client";
import { preparationOverview } from "@/modules/catalogue/preparation";
import { type ReadinessBasis, READINESS_ITEMS } from "@/modules/catalogue/readiness";
import { OfficeShell, Section } from "../_components/shell";
import { requireOffice } from "../_lib/session";

export const metadata = { title: "Catalogue preparation · Owner Office" };

const GROUPS: { basis: ReadinessBasis; title: string; note: string }[] = [
  { basis: "approved", title: "Approved requirements", note: "Founder-stated or founder-approved (S-1, I-9, I-10)." },
  { basis: "pending", title: "Publication proposals, not approved", note: "From the proposed rules I-6 and S-6, waiting for your decision. Meeting them does not make a product publishable." },
  { basis: "recommended", title: "Optional suggestions", note: "Engineering and merchandising suggestions, never rules." },
];

// How many draft products still need each piece of content, from the database now. Advisory only: no product is
// eligible for publication under any rule (none is approved) and there is no publish action.
export default async function PreparationPage() {
  const principal = await requireOffice("catalog:read");
  const { drafts, unmet } = await preparationOverview(getDb(), principal);
  return (
    <OfficeShell title="Catalogue preparation" current="preparation">
      <p className="text-sm text-gray-700">
        {drafts} draft product{drafts === 1 ? "" : "s"}. Each line counts the drafts that do not have that yet; the link lists them. This is a preparation aid only: nothing here publishes a
        product, and the delivery and return policy text that every product page needs is not approved yet.
      </p>
      {GROUPS.map((g) => (
        <Section key={g.basis} title={g.title}>
          <p className="text-xs text-gray-600">{g.note}</p>
          <table className="w-full text-left text-sm" data-testid={`preparation-${g.basis}`}>
            <thead className="border-b border-gray-300 text-gray-600">
              <tr>
                <th scope="col" className="py-2 pr-3">Item</th>
                <th scope="col" className="py-2 pr-3">Basis</th>
                <th scope="col" className="py-2 text-right">Drafts without it</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {READINESS_ITEMS.filter((i) => i.basis === g.basis).map((i) => (
                <tr key={i.id} data-testid={`preparation-${i.id}`}>
                  <th scope="row" className="py-2 pr-3 font-normal">
                    {i.label}
                  </th>
                  <td className="py-2 pr-3 text-xs text-gray-600">{i.source}</td>
                  <td className="py-2 text-right tabular-nums">
                    {unmet[i.id] === 0 ? (
                      "0"
                    ) : (
                      <Link href={`/office?status=draft&missing=${i.id}`} className="underline">
                        {unmet[i.id]}
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      ))}
    </OfficeShell>
  );
}
