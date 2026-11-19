"use client";

import { useState } from "react";
import { regenerateRecoveryCodesAction } from "../actions";

/** Makes a new set of recovery codes and shows it once (the old codes stop working). */
export function RecoveryCodes() {
  const [codes, setCodes] = useState<string[] | null>(null);
  const [pending, setPending] = useState(false);
  async function make() {
    if (!window.confirm("Make new recovery codes? Your old codes will stop working.")) return;
    setPending(true);
    setCodes(await regenerateRecoveryCodesAction().catch(() => null));
    setPending(false);
  }
  return (
    <div className="space-y-3">
      <button type="button" onClick={make} disabled={pending} className="of-btn of-btn-line">
        {pending ? "Making…" : "Make new recovery codes"}
      </button>
      {codes ? (
        <div className="space-y-2">
          <p className="text-sm font-semibold">Save these now. They are shown only once.</p>
          <ol className="grid grid-cols-1 gap-1 rounded-xl bg-gray-50 p-4 font-mono text-sm sm:grid-cols-2" data-testid="new-recovery-codes">
            {codes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}
