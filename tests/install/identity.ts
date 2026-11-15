// The fictional business the installation rehearsal (tests/install/setup.ts) configures. Nothing here is real.
export const REHEARSAL_IDENTITY = {
  STORE_NAME: "Rehearsal Kids Shop",
  STORE_LINE_EN: "A fictional shop used to rehearse a fresh installation.",
  STORE_LINE_BN: "নতুন ইনস্টলেশন যাচাইয়ের জন্য একটি কাল্পনিক দোকান।",
  STORE_CONTACT_PHONE: "+880 1711-000099",
  STORE_CONTACT_EMAIL: "hello@rehearsal.example.test",
  STORE_THEME_INK: "#1f2a44",
  STORE_THEME_ACCENT: "#e0b04a",
  STORE_THEME_PAPER: "#fbfaf7",
} as const;

/** Any spelling of the original business's name. */
export const ORIGINAL_BRAND = /baby\s*sunray/i;
