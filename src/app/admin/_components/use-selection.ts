"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Tracks the ticked row checkboxes of a server-rendered table. A row checkbox has class `of-check`, `form="<formId>"` and may
 * carry `data-step` (what that row can do); a header checkbox has `data-select-all` and ticks every row. Returns how many
 * rows are ticked and the distinct steps among them, and a function that unticks everything.
 */
export function useSelection(formId: string) {
  const [picked, setPicked] = useState<{ count: number; steps: string[] }>({ count: 0, steps: [] });
  const boxes = `input.of-check[form="${formId}"]`;
  const read = useCallback(() => {
    const ticked = [...document.querySelectorAll<HTMLInputElement>(`${boxes}:checked`)];
    setPicked({ count: ticked.length, steps: [...new Set(ticked.map((b) => b.dataset.step ?? ""))] });
  }, [boxes]);

  useEffect(() => {
    const onChange = (event: Event) => {
      const target = event.target as HTMLInputElement;
      if (target.matches("input[data-select-all]")) for (const box of document.querySelectorAll<HTMLInputElement>(boxes)) box.checked = target.checked;
      if (target.matches("input[data-select-all]") || target.matches(boxes)) read();
    };
    document.addEventListener("change", onChange);
    const first = requestAnimationFrame(read); // rows ticked before this script ran (a browser restoring a form)
    return () => {
      cancelAnimationFrame(first);
      document.removeEventListener("change", onChange);
    };
  }, [boxes, read]);

  const reset = useCallback(() => {
    for (const box of document.querySelectorAll<HTMLInputElement>(`${boxes}, input[data-select-all]`)) box.checked = false;
    setPicked({ count: 0, steps: [] });
  }, [boxes]);

  return { picked, reset };
}
