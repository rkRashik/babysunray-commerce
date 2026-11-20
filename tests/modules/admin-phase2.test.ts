import { describe, expect, it } from "vitest";
import { openSearch, sealSearch, SEARCH_TTL_SECONDS } from "../../src/app/admin/orders/_lib/search-cookie";
import { slugify } from "../../src/modules/catalogue/rules";
import { formatTaka } from "../../src/modules/storefront/i18n";

const SECRET = "x".repeat(40);
const USER = "11111111-1111-1111-1111-111111111111";

describe("order search cookie", () => {
  it("round-trips for the same user and hides the term", () => {
    const sealed = sealSearch("Rahim 01712345678", USER, SECRET);
    expect(sealed).not.toContain("Rahim");
    expect(sealed).not.toContain("01712345678");
    expect(openSearch(sealed, USER, SECRET)).toBe("Rahim 01712345678");
  });

  it("is refused for another user, another secret, an altered value, an expired one and rubbish", () => {
    const now = Date.now();
    const sealed = sealSearch("Rahim", USER, SECRET, now);
    expect(openSearch(sealed, "22222222-2222-2222-2222-222222222222", SECRET, now)).toBeNull();
    expect(openSearch(sealed, USER, "y".repeat(40), now)).toBeNull();
    const bytes = Buffer.from(sealed, "base64url");
    bytes[bytes.length - 1] ^= 1;
    expect(openSearch(bytes.toString("base64url"), USER, SECRET, now)).toBeNull();
    expect(openSearch(sealed, USER, SECRET, now + (SEARCH_TTL_SECONDS + 1) * 1000)).toBeNull();
    for (const bad of [undefined, "", "abc", "A".repeat(2000), "%%%"]) expect(openSearch(bad, USER, SECRET, now)).toBeNull();
  });

  it("never seals the same term twice the same way", () => {
    expect(sealSearch("Rahim", USER, SECRET)).not.toBe(sealSearch("Rahim", USER, SECRET));
  });
});

describe("slugify", () => {
  it("makes a clean stem from a name", () => {
    expect(slugify("Cotton Romper (0-3M)!")).toBe("cotton-romper-0-3m");
    expect(slugify("  Crème   Brûlée Set ")).toBe("creme-brulee-set");
    expect(slugify("a".repeat(100)).length).toBe(60);
  });
  it("falls back for a name with no Latin letters or digits", () => {
    expect(slugify("সুতির রম্পার")).toBe("product");
    expect(slugify("")).toBe("product");
  });
});

describe("Admin money", () => {
  it("shows whole taka without decimals and keeps real paisa", () => {
    expect(formatTaka(1_281_000, "en")).toBe("৳ 12,810");
    expect(formatTaka(1_281_050, "en")).toBe("৳ 12,810.50");
    expect(formatTaka(5, "en")).toBe("৳ 0.05");
    expect(formatTaka(0, "en")).toBe("৳ 0");
  });
});
