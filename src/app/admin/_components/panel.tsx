import { ChevronDown } from "lucide-react";

/**
 * A less frequent task behind a button-like summary, so reading a page is not a wall of forms. Native details: it
 * works without JavaScript and keeps typed values while open. Give it a `key` that changes with a save (the record's version), so it
 * closes again once the save has gone through.
 */
export function ActionPanel({ label, open, danger, children }: { label: string; open?: boolean; danger?: boolean; children: React.ReactNode }) {
  return (
    <details className="of-panel" open={open} data-tone={danger ? "danger" : undefined}>
      <summary>
        {label}
        <ChevronDown aria-hidden="true" size={16} />
      </summary>
      <div role="region" aria-label={label} className="of-panel-body space-y-3">
        {children}
      </div>
    </details>
  );
}
