import localFont from "next/font/local";

// First Light type (docs/design/storefront-design-system.md), self-hosted from the @fontsource packages with
// next/font/local: nothing is requested from another site (the tracking page's CSP forbids it anyway). All four are under
// the SIL Open Font License 1.1. Each face covers only its script (unicode-range), so a page downloads the Bangla files
// only where Bangla text (or the taka sign) appears. (next/font needs every option written out literally.)
//   Fraunces (display, Latin): optical-size and weight axes, for headings and the home page's opening.
//   Figtree (text, Latin): weight axis, for everything else; the only file preloaded.
//   Tiro Bangla (display, Bangla): regular, for Bangla headings.
//   Hind Siliguri (text, Bangla): 400 and 600 only (a heavier request resolves to 600, a lighter one to 400).

export const flDisplay = localFont({
  src: "../../../node_modules/@fontsource-variable/fraunces/files/fraunces-latin-opsz-normal.woff2",
  weight: "100 900",
  display: "swap",
  preload: false,
  variable: "--font-fl-display",
  declarations: [
    {
      prop: "unicode-range",
      value: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
});

export const flText = localFont({
  src: "../../../node_modules/@fontsource-variable/figtree/files/figtree-latin-wght-normal.woff2",
  weight: "300 900",
  display: "swap",
  variable: "--font-fl-text",
  declarations: [
    {
      prop: "unicode-range",
      value: "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
});

export const flBanglaDisplay = localFont({
  src: "../../../node_modules/@fontsource/tiro-bangla/files/tiro-bangla-bengali-400-normal.woff2",
  weight: "400",
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  variable: "--font-fl-bn-display",
  declarations: [
    {
      prop: "unicode-range",
      value: "U+0951-0952, U+0964-0965, U+0980-09FE, U+1CD0, U+1CD2, U+1CD5-1CD6, U+1CD8, U+1CE1, U+1CEA, U+1CED, U+1CF2, U+1CF5-1CF7, U+200C-200D, U+20B9, U+25CC, U+A8F1",
    },
  ],
});

export const flBanglaText = localFont({
  src: [
    { path: "../../../node_modules/@fontsource/hind-siliguri/files/hind-siliguri-bengali-400-normal.woff2", weight: "400" },
    { path: "../../../node_modules/@fontsource/hind-siliguri/files/hind-siliguri-bengali-600-normal.woff2", weight: "600" },
  ],
  display: "swap",
  preload: false,
  adjustFontFallback: false,
  variable: "--font-fl-bn-text",
  declarations: [
    // Hind Siliguri draws smaller than Figtree at the same size; this evens out English and Bangla text.
    { prop: "size-adjust", value: "110%" },
    {
      prop: "unicode-range",
      value: "U+0951-0952, U+0964-0965, U+0980-09FE, U+1CD0, U+1CD2, U+1CD5-1CD6, U+1CD8, U+1CE1, U+1CEA, U+1CED, U+1CF2, U+1CF5-1CF7, U+200C-200D, U+20B9, U+25CC, U+A8F1",
    },
  ],
});

/** Class names that define the four font variables; put them on the root element of a First Light surface. */
export const flFontVariables = `${flDisplay.variable} ${flText.variable} ${flBanglaDisplay.variable} ${flBanglaText.variable}`;
