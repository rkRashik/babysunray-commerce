// The counting convention (src/modules/inventory/counts.ts, rule 1), shown on the count page and the count sheet.
export function CountingConvention() {
  return (
    <div className="rounded border border-gray-300 bg-gray-50 px-3 py-2 text-sm">
      <p className="font-medium">How to count</p>
      <ul className="ml-4 list-disc space-y-1">
        <li>Count every sellable unit in the shop, including units set aside for orders that have not been dispatched yet (they are still on hand).</li>
        <li>Do not count returned or RTO goods waiting for inspection: they are kept apart and a count never changes them.</li>
        <li>Orders, dispatches and receipts can continue while you count. If a SKU&rsquo;s stock moves after you entered its count, you are asked to recount it.</li>
      </ul>
    </div>
  );
}
