"use client";

import { Drawer } from "@base-ui/react/drawer";
import { X } from "lucide-react";
import type { RefObject } from "react";
import { usePortal, useWide } from "./frame";

// A sheet (Base UI Drawer): a bottom sheet on a phone that can be swiped away, a panel from the right on a desktop.
// `top` drops from the top on a phone instead (search: the field stays above the on-screen keyboard). Focus moves into the
// sheet and back to its trigger, the page behind does not scroll, and Escape or the close button closes it.

type Props = {
  title: string;
  closeLabel: string;
  trigger: React.ReactNode;
  triggerClassName: string;
  /** For an icon-only trigger. */
  triggerLabel?: string;
  triggerTestId?: string;
  side?: "bottom" | "top";
  initialFocus?: RefObject<HTMLElement | null>;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  testId?: string;
  children: React.ReactNode;
};

export function Sheet({ title, closeLabel, trigger, triggerClassName, triggerLabel, triggerTestId, side = "bottom", initialFocus, open, onOpenChange, testId, children }: Props) {
  const portal = usePortal();
  const wide = useWide();
  const direction = wide ? "right" : side === "top" ? "up" : "down";
  return (
    <Drawer.Root swipeDirection={direction} open={open} onOpenChange={onOpenChange ? (next) => onOpenChange(next) : undefined}>
      <Drawer.Trigger className={triggerClassName} aria-label={triggerLabel} data-testid={triggerTestId}>
        {trigger}
      </Drawer.Trigger>
      <Drawer.Portal container={portal ?? undefined}>
        <Drawer.Backdrop className="sf-sheet-backdrop" />
        <Drawer.Viewport className="sf-sheet-viewport" data-direction={direction}>
          <Drawer.Popup className="sf-sheet" data-direction={direction} initialFocus={initialFocus} data-testid={testId}>
            {direction === "down" ? <span aria-hidden="true" className="sf-sheet-handle" /> : null}
            <div className="sf-sheet-head">
              <Drawer.Title className="text-lg font-semibold">{title}</Drawer.Title>
              <Drawer.Close className="sf-icon-btn -me-2" aria-label={closeLabel}>
                <X aria-hidden="true" size={22} strokeWidth={1.75} />
              </Drawer.Close>
            </div>
            <Drawer.Content className="sf-sheet-content">{children}</Drawer.Content>
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
