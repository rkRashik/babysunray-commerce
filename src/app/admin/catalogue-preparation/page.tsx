import Link from "next/link";
import { getDb } from "@/db/client";
import { preparationOverview } from "@/modules/catalogue/preparation";
import { publicationRuleFor } from "@/modules/catalogue/publication";
import { READINESS_ITEMS } from "@/modules/catalogue/readiness";
import { readinessGroups } from "../_components/content";
import { AdminShell, Section } from "../_components/shell";
import { requireAdmin } from "../_lib/session";

export const metadata = { title: "Catalogue preparation · Admin" };

// How many draft products still need each piece of content, from the database now, grouped the way the product page
// groups its checklist (what publishing needs under the rule in force, then optional improvements).
export default async function PreparationPage() {
  const principal = await requireAdmin("catalog:read");
  const db = getDb();
  const [{ drafts, unmet }, rule] = await Promise.all([preparationOverview(db, principal), publicationRuleFor(db)]);
  const groups = readinessGroups([...READINESS_ITEMS], rule);

  return (
    <AdminShell title="Catalogue preparation" current="preparation">
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="of-stat">
          <dt>Draft products</dt>
          <dd>{drafts}</dd>
        </div>
        <div className="of-stat">
          <dt>Publication requirements</dt>
          <dd>
            {rule ? (
              "In force"
            ) : (
              <Link href="/admin/settings/publication" className="underline">
                Not chosen yet
              </Link>
            )}
          </dd>
        </div>
      </dl>
      <p className="text-sm text-gray-700">
        Each line counts the draft products that still need it; select a number to see them. Products are published one by one from their own page, after a review.
      </p>
      {groups.filter((g) => g.items.length).map((g) => (
        <Section key={g.key} title={g.title}>
          <p className="text-xs text-gray-600">{g.note}</p>
          <div className="overflow-hidden rounded-xl border border-gray-200">
            <table className="of-table" data-testid={`preparation-${g.key}`}>
              <thead>
                <tr>
                  <th scope="col">What the product needs</th>
                  <th scope="col" className="num">
                    Drafts without it
                  </th>
                </tr>
              </thead>
              <tbody>
                {g.items.map((i) => (
                  <tr key={i.id} data-testid={`preparation-${i.id}`}>
                    <th scope="row" className="font-normal">
                      {i.label}
                    </th>
                    <td className="num">
                      {unmet[i.id] === 0 ? (
                        <span className="text-gray-500">0</span>
                      ) : (
                        <Link href={`/admin?status=draft&missing=${i.id}`} className="font-semibold underline" aria-label={`${unmet[i.id]} drafts without: ${i.label}`}>
                          {unmet[i.id]}
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      ))}
    </AdminShell>
  );
}
