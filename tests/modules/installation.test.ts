import { describe, expect, it } from "vitest";
import { contrast, DEFAULT_STORE_NAME, DEFAULT_THEME, readInstallationIdentity } from "../../src/config/installation";
import { configChecks } from "../../src/config/readiness";

// Per-installation identity: neutral defaults, validated settings, readable colours (fictional businesses only).

describe("installation identity", () => {
  it("is neutral by default: no other business's name, description or contact", () => {
    const { identity, problems } = readInstallationIdentity({});
    expect(identity).toEqual({ storeName: DEFAULT_STORE_NAME, storeLine: { en: null, bn: null }, contact: { phone: null, email: null }, theme: DEFAULT_THEME });
    expect(problems).toEqual([]);
    expect(JSON.stringify(identity)).not.toMatch(/babysunray/i);
  });

  it("takes a fictional business's name, bilingual description, contact and readable colours", () => {
    const { identity, problems } = readInstallationIdentity({
      STORE_NAME: " Fictional Kids Co ",
      STORE_LINE_EN: "Fictional clothes for testing.",
      STORE_LINE_BN: "পরীক্ষার জন্য কাল্পনিক পোশাক।",
      STORE_CONTACT_PHONE: "+880 1711-000099",
      STORE_CONTACT_EMAIL: "shop@example.test",
      STORE_THEME_INK: "#1F2A44",
      STORE_THEME_ACCENT: "#E0B04A",
      STORE_THEME_PAPER: "#FBFAF7",
    });
    expect(problems).toEqual([]);
    expect(identity).toEqual({
      storeName: "Fictional Kids Co",
      storeLine: { en: "Fictional clothes for testing.", bn: "পরীক্ষার জন্য কাল্পনিক পোশাক।" },
      contact: { phone: "+880 1711-000099", email: "shop@example.test" },
      theme: { ink: "#1f2a44", accent: "#e0b04a", paper: "#fbfaf7" },
    });
  });

  it("refuses unreadable colours, malformed values and control characters, falling back to the defaults", () => {
    const { identity, problems } = readInstallationIdentity({
      STORE_NAME: "Bad\u0007Name",
      STORE_LINE_EN: "x".repeat(201),
      STORE_CONTACT_PHONE: "call me",
      STORE_CONTACT_EMAIL: "not-an-email",
      STORE_THEME_INK: "#cccccc",
      STORE_THEME_PAPER: "#ffffff",
    });
    expect(identity.storeName).toBe(DEFAULT_STORE_NAME);
    expect(identity.theme).toEqual(DEFAULT_THEME);
    expect(identity.contact).toEqual({ phone: null, email: null });
    expect(problems.join(" ")).toMatch(/STORE_NAME[\s\S]*STORE_LINE_EN[\s\S]*STORE_CONTACT_PHONE[\s\S]*STORE_CONTACT_EMAIL[\s\S]*not readable enough/);
    expect(readInstallationIdentity({ STORE_THEME_ACCENT: "orange" }).problems[0]).toMatch(/STORE_THEME_ACCENT must be a colour/);
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast(DEFAULT_THEME.ink, DEFAULT_THEME.paper)).toBeGreaterThan(7);
  });

  it("shows up in the configuration check without echoing values", () => {
    const checks = configChecks({ STORE_NAME: "Fictional Kids Co", STORE_THEME_INK: "#eeeeee" });
    expect(checks.find((c) => c.name === "STORE_NAME")).toMatchObject({ status: "ok" });
    const theme = checks.find((c) => c.detail.includes("not readable enough"));
    expect(theme).toMatchObject({ status: "invalid" });
    expect(JSON.stringify(checks)).not.toContain("#eeeeee");
  });
});
