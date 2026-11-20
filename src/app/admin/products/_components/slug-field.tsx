"use client";

import { useEffect, useId, useRef, useState } from "react";
import { suggestSlugAction } from "../../actions";

/**
 * The product's web address, under an "advanced" disclosure. It follows the product name (a free address is asked from the
 * server a moment after typing stops) until the Owner edits it by hand; left empty, the server makes one from the name anyway.
 */
export function SlugField() {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const touched = useRef(false);
  const [slug, setSlug] = useState("");

  useEffect(() => {
    const form = input.current?.form;
    if (!form) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onInput = (event: Event) => {
      const target = event.target as HTMLInputElement;
      if (target.name !== "nameEn" && target.name !== "nameBn") return;
      clearTimeout(timer);
      timer = setTimeout(async () => {
        if (touched.current) return;
        const data = new FormData(form);
        const name = String(data.get("nameEn") || data.get("nameBn") || "").trim();
        if (!name) return setSlug("");
        const suggestion = await suggestSlugAction(name).catch(() => "");
        if (!touched.current) setSlug(suggestion);
      }, 500);
    };
    form.addEventListener("input", onInput);
    return () => {
      clearTimeout(timer);
      form.removeEventListener("input", onInput);
    };
  }, []);

  return (
    <details className="rounded-xl border border-gray-300 bg-white px-4 py-3">
      <summary className="cursor-pointer text-sm font-semibold">
        Web address (advanced) <span className="font-normal text-gray-600">· {slug || "made from the name"}</span>
      </summary>
      <div className="mt-3">
        <label htmlFor={id} className="block text-sm font-semibold">
          Slug
        </label>
        <input
          ref={input}
          id={id}
          name="slug"
          value={slug}
          maxLength={100}
          autoComplete="off"
          spellCheck={false}
          className="of-input mt-1.5 font-mono"
          aria-describedby={`${id}-hint`}
          onChange={(event) => {
            touched.current = true;
            setSlug(event.target.value);
          }}
        />
        <p id={`${id}-hint`} className="mt-1.5 text-[0.8125rem] text-gray-600">
          Suggested from the name and checked for a free address. Lowercase letters, digits and single hyphens, for example cotton-romper. It cannot be changed after the product is created.
        </p>
      </div>
    </details>
  );
}
