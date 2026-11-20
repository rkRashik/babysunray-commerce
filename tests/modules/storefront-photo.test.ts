import { afterEach, describe, expect, it, vi } from "vitest";
import { cdnFor } from "../../src/app/admin/storefront-preview/_components/parts";

// Which delivery a storefront photo uses (Gate H.60): Cloudinary only when the photo has a recorded CDN copy (which exists
// only while its product is published) and Cloudinary is configured; every other photo comes from the Owner-only media route.

const ENV = { CLOUDINARY_CLOUD_NAME: "demo-cloud", CLOUDINARY_API_KEY: "123456789012345", CLOUDINARY_API_SECRET: "fictional-secret-value" };
afterEach(() => vi.unstubAllEnvs());

describe("cdnFor", () => {
  it("returns Cloudinary URLs (three widths) for a photo with a copy when Cloudinary is configured", () => {
    for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
    const images = cdnFor({ cdnPublicId: "babysunray/products/abc_0123456789abcdef" });
    expect(images?.src).toBe("https://res.cloudinary.com/demo-cloud/image/upload/f_auto,q_auto,c_limit,w_640/babysunray/products/abc_0123456789abcdef");
    expect(images?.srcSet.split(", ")).toHaveLength(3);
  });
  it("returns null for a photo without a copy (a draft's photo), and for any photo when Cloudinary is not configured or is misconfigured", () => {
    for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
    expect(cdnFor({ cdnPublicId: null })).toBeNull();
    expect(cdnFor({})).toBeNull();
    for (const k of Object.keys(ENV)) vi.stubEnv(k, "");
    expect(cdnFor({ cdnPublicId: "x/y_1" })).toBeNull();
    vi.stubEnv("CLOUDINARY_CLOUD_NAME", "demo-cloud");
    expect(cdnFor({ cdnPublicId: "x/y_1" })).toBeNull();
  });
});
