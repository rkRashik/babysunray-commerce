"use client";

import { Pencil } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CancelEdit } from "./action-form";

const LEAVE = "Leave this page? Your changes have not been saved.";
const DISCARD = "Discard your changes? Nothing you changed here will be saved.";

/**
 * A settings card that shows the saved values as text and becomes a form only after "Edit" (stable settings that are
 * rarely changed: store details, delivery charges). The edit form is an ActionForm: its idempotency key, version check
 * and error handling are unchanged; it shows Cancel beside its submit button. Once something is typed, leaving the page
 * or cancelling asks first. The page gives this a `key` that changes when the record's version changes, so a successful
 * save (which reloads the page with the new version) shows the saved values again.
 */
export function EditableSection({ title, editLabel, view, children }: { title: string; editLabel: string; view: React.ReactNode; children: React.ReactNode }) {
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);
  const id = `section-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  useLeaveGuard(editing && dirty);

  useEffect(() => {
    if (editing) body.current?.querySelector<HTMLElement>("input:not([type=hidden]), textarea, select")?.focus();
    else if (restoreFocus.current) editButton.current?.focus();
    restoreFocus.current = false;
  }, [editing]);

  function cancel() {
    if (dirty && !window.confirm(DISCARD)) return;
    restoreFocus.current = true;
    setDirty(false);
    setEditing(false);
  }

  return (
    <section aria-labelledby={id} className="of-card space-y-4 p-5 lg:p-6" data-editing={editing ? "true" : undefined}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={id} className="text-[1.0625rem] font-bold">
          {title}
        </h2>
        {editing ? (
          <span className="of-pill" data-tone="wait">
            Editing
          </span>
        ) : (
          <button ref={editButton} type="button" onClick={() => setEditing(true)} className="of-btn of-btn-line of-btn-sm">
            <Pencil aria-hidden="true" size={16} />
            {editLabel}
          </button>
        )}
      </div>
      {editing ? (
        <div ref={body} onInput={() => setDirty(true)}>
          <CancelEdit.Provider value={cancel}>{children}</CancelEdit.Provider>
        </div>
      ) : (
        view
      )}
    </section>
  );
}

/** While `active`, closing or reloading the tab and following a link on the page ask before the typed changes are lost. */
export function useLeaveGuard(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const beforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    // Capture phase on the document runs before Next.js handles the link, so a refusal stops the navigation.
    const click = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.getAttribute("target") === "_blank") return;
      // A jump within this page (#section-…) loses nothing.
      const to = new URL((link as HTMLAnchorElement).href, location.href);
      if (to.hash && to.pathname === location.pathname && to.search === location.search) return;
      if (!window.confirm(LEAVE)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", click, true);
    };
  }, [active]);
}

/** Wraps a page-sized form that is always editable (for example a product's details): once something is typed, leaving asks first. */
export function UnsavedChangesGuard({ children }: { children: React.ReactNode }) {
  const [dirty, setDirty] = useState(false);
  useLeaveGuard(dirty);
  return <div onInput={() => setDirty(true)}>{children}</div>;
}
