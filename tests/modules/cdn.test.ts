import { describe, expect, it, vi } from "vitest";
import { cdnClient, cdnConfig, CdnError, cdnImages, cdnPublicId, signCloudinary } from "../../src/modules/media/cdn";
import { hostedConfigProblems } from "../../src/config/hosted";

// The Cloudinary client (Gate H.57) without a network: a stubbed fetch records what would be sent. Fictional settings only.

const ENV = { CLOUDINARY_CLOUD_NAME: "demo-cloud", CLOUDINARY_API_KEY: "123456789012345", CLOUDINARY_API_SECRET: "fictional-secret-value" };
const config = (extra: Record<string, string> = {}) => {
  const c = cdnConfig({ ...ENV, ...extra });
  if (!c.ok || !c.config) throw new Error("expected a configuration");
  return c.config;
};

describe("cdnConfig", () => {
  it("is off (null) when no CLOUDINARY_* setting is present, and on with the three required ones and a default folder", () => {
    expect(cdnConfig({})).toEqual({ ok: true, config: null });
    expect(config()).toEqual({ cloudName: "demo-cloud", apiKey: "123456789012345", apiSecret: "fictional-secret-value", folder: "babysunray/products" });
    expect(config({ CLOUDINARY_FOLDER: "shop/kids" }).folder).toBe("shop/kids");
  });
  it("names each missing or malformed setting (names and rules only, never a value)", () => {
    const partial = cdnConfig({ CLOUDINARY_CLOUD_NAME: "demo-cloud" });
    expect(partial.ok ? [] : partial.problems.map((p) => p.name)).toEqual(["CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"]);
    const bad = cdnConfig({ ...ENV, CLOUDINARY_CLOUD_NAME: "bad name!", CLOUDINARY_API_KEY: "abc", CLOUDINARY_FOLDER: "../escape" });
    expect(bad.ok ? [] : bad.problems.map((p) => p.name).sort()).toEqual(["CLOUDINARY_API_KEY", "CLOUDINARY_CLOUD_NAME", "CLOUDINARY_FOLDER"]);
    const json = JSON.stringify(bad);
    expect(json).not.toContain("fictional-secret-value");
  });
  it("is part of the hosted configuration check only when a CLOUDINARY_* setting is present", () => {
    const base = { DATABASE_URL: "postgresql://u:p@h.example.com:5432/d", BETTER_AUTH_SECRET: "x".repeat(40), BETTER_AUTH_URL: "https://shop.example.com" };
    const names = (env: Record<string, string>) => hostedConfigProblems(env).map((p) => p.name);
    expect(names({ ...base, ...ENV })).not.toContain("CLOUDINARY_API_KEY");
    expect(names({ ...base, CLOUDINARY_CLOUD_NAME: "demo-cloud" })).toEqual(expect.arrayContaining(["CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"]));
  });
});

describe("signing and naming", () => {
  it("signs the sorted parameters followed by the secret with SHA-1 (Cloudinary's documented example)", () => {
    expect(signCloudinary({ timestamp: "1315060510", public_id: "sample_image" }, "abcd")).toBe("b4ad47fb4e25c7bf5f92a20089f9db59bc302313");
  });
  it("derives a public id from the photo's id and content, so replaced content never reuses a URL", () => {
    const sha = "a".repeat(64);
    const a = cdnPublicId({ folder: "f" }, { id: "11111111-1111-1111-1111-111111111111", sha256: sha });
    expect(a).toBe("f/11111111-1111-1111-1111-111111111111_aaaaaaaaaaaaaaaa");
    expect(cdnPublicId({ folder: "f" }, { id: "11111111-1111-1111-1111-111111111111", sha256: "b".repeat(64) })).not.toBe(a);
  });
  it("builds responsive Cloudinary URLs (auto format and quality, never enlarged) for three widths", () => {
    const { src, srcSet } = cdnImages({ cloudName: "demo-cloud" }, "f/x_1");
    expect(src).toBe("https://res.cloudinary.com/demo-cloud/image/upload/f_auto,q_auto,c_limit,w_640/f/x_1");
    expect(srcSet.split(", ")).toEqual([
      "https://res.cloudinary.com/demo-cloud/image/upload/f_auto,q_auto,c_limit,w_320/f/x_1 320w",
      "https://res.cloudinary.com/demo-cloud/image/upload/f_auto,q_auto,c_limit,w_640/f/x_1 640w",
      "https://res.cloudinary.com/demo-cloud/image/upload/f_auto,q_auto,c_limit,w_1280/f/x_1 1280w",
    ]);
  });
});

describe("cdnClient", () => {
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const sent = (fetcher: ReturnType<typeof vi.fn>) => {
    const [url, init] = fetcher.mock.calls[0] as [string, { body: FormData }];
    return { url, form: init.body };
  };

  it("uploads a signed copy: the secret is never sent, the signature matches the other parameters", async () => {
    const fetcher = vi.fn(async () => reply({ public_id: "f/x_1" }));
    await cdnClient(config(), fetcher as unknown as typeof fetch).upload("f/x_1", Buffer.from("image-bytes"), "image/webp");
    const { url, form } = sent(fetcher);
    expect(url).toBe("https://api.cloudinary.com/v1_1/demo-cloud/image/upload");
    expect(form.get("public_id")).toBe("f/x_1");
    expect(form.get("api_key")).toBe(ENV.CLOUDINARY_API_KEY);
    expect([...form.values()].some((v) => typeof v === "string" && v.includes(ENV.CLOUDINARY_API_SECRET))).toBe(false);
    expect(form.get("signature")).toBe(signCloudinary({ public_id: "f/x_1", timestamp: String(form.get("timestamp")) }, ENV.CLOUDINARY_API_SECRET));
    expect((form.get("file") as File).size).toBe("image-bytes".length);
  });
  it("destroys with invalidation (the signature covers it); an already deleted copy is success", async () => {
    for (const result of ["ok", "not found"]) {
      const fetcher = vi.fn(async () => reply({ result }));
      await cdnClient(config(), fetcher as unknown as typeof fetch).destroy("f/x_1");
      const { url, form } = sent(fetcher);
      expect(url).toBe("https://api.cloudinary.com/v1_1/demo-cloud/image/destroy");
      expect(form.get("invalidate")).toBe("true");
      expect(form.get("signature")).toBe(signCloudinary({ invalidate: "true", public_id: "f/x_1", timestamp: String(form.get("timestamp")) }, ENV.CLOUDINARY_API_SECRET));
    }
  });
  it("fails with a CdnError that carries a status and no response text, for an HTTP error, a network error and an unexpected answer", async () => {
    const client = (fetcher: unknown) => cdnClient(config(), fetcher as typeof fetch);
    const http = await client(async () => reply({ error: { message: "fictional-secret-value leaked" } }, 401)).destroy("f/x").catch((e: unknown) => e);
    expect(http).toBeInstanceOf(CdnError);
    expect((http as CdnError).status).toBe(401);
    expect(String(http)).not.toContain("leaked");
    const network = await client(async () => { throw new Error("socket fictional-secret-value"); }).destroy("f/x").catch((e: unknown) => e);
    expect((network as CdnError).status).toBeNull();
    expect(String(network)).not.toContain("fictional-secret-value");
    await expect(client(async () => reply({ result: "error" })).destroy("f/x")).rejects.toBeInstanceOf(CdnError);
    await expect(client(async () => reply({ public_id: "someone/else" })).upload("f/x", Buffer.from("a"), "image/png")).rejects.toBeInstanceOf(CdnError);
  });
});
