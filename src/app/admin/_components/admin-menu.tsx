"use client";

import { Dialog } from "@base-ui/react/dialog";
import { Menu, X } from "lucide-react";
import { useState } from "react";

// The phone's "Menu": every Admin page in one list, opened from the bottom bar's last button (shell.tsx). A sheet that rises
// from the bottom (Base UI Dialog: focus is trapped and returned, Escape and the close button close it, the page behind does
// not scroll). The list itself (children) is server-rendered; choosing a link closes the sheet. The sheet renders inside the
// Admin's own root, so it keeps Admin palette and fonts.

export function AdminMenu({ title, closeLabel, label, highlighted, children }: { title: string; closeLabel: string; label: string; highlighted: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger className="of-tab" aria-current={highlighted ? "page" : undefined} data-testid="admin-menu-button">
        <Menu aria-hidden="true" size={24} strokeWidth={1.75} />
        <span>{label}</span>
      </Dialog.Trigger>
      <div ref={setHost} />
      {host ? (
        <Dialog.Portal container={host}>
          <Dialog.Backdrop className="fixed inset-0 z-40 bg-[rgb(51_41_35/0.45)] transition-opacity duration-300 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
          <Dialog.Popup
            className="fixed inset-x-0 bottom-0 z-50 flex max-h-[88dvh] flex-col rounded-t-[1.75rem] bg-white pb-[env(safe-area-inset-bottom,0px)] shadow-[0_-12px_40px_-12px_rgb(51_41_35/0.3)] outline-none transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] data-[ending-style]:translate-y-full data-[starting-style]:translate-y-full"
            data-testid="admin-menu"
          >
            <div className="flex items-center justify-between gap-4 px-5 pt-4 pb-2">
              <Dialog.Title className="text-lg font-bold">{title}</Dialog.Title>
              <Dialog.Close aria-label={closeLabel} className="inline-flex h-11 w-11 items-center justify-center rounded-full hover:bg-gray-100">
                <X aria-hidden="true" size={22} strokeWidth={1.75} />
              </Dialog.Close>
            </div>
            <div
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-5"
              onClick={(event) => {
                if ((event.target as HTMLElement).closest("a")) setOpen(false);
              }}
            >
              {children}
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      ) : null}
    </Dialog.Root>
  );
}
