import { describe, expect, it } from "vitest";
import { photoId, unprovenCancellations } from "../e2e/cancelled-photos";

const A = "0b6f6f0e-1111-4c1a-9d1e-aaaaaaaaaaaa";
const B = "0b6f6f0e-2222-4c1a-9d1e-bbbbbbbbbbbb";
const url = (id: string, w: number) => `https://127.0.0.1:3443/api/public/media/${id}?w=${w}`;

describe("photoId", () => {
  it("reads the id of the shop and Admin photo routes only", () => {
    expect(photoId(url(A, 640))).toBe(A);
    expect(photoId(`https://127.0.0.1/admin/media/${A}?w=320`)).toBe(A);
    expect(photoId(`https://127.0.0.1/admin/media/${A}/extra`)).toBeNull();
    expect(photoId("https://127.0.0.1/brand/logo.png")).toBeNull();
    expect(photoId("https://res.cloudinary.com/x/image/upload/a.jpg")).toBeNull();
  });
});

describe("unprovenCancellations", () => {
  it("accepts a cancelled candidate when the same photo was served and is drawn", () => {
    expect(unprovenCancellations([{ id: A, url: url(A, 640) }], new Set([A]), [url(A, 320)])).toEqual([]);
  });

  it("fails when the photo was never served on the page", () => {
    expect(unprovenCancellations([{ id: A, url: url(A, 640) }], new Set(), [url(A, 320)])).toHaveLength(1);
  });

  it("fails when the photo was served but no image on the page is drawn from it", () => {
    expect(unprovenCancellations([{ id: A, url: url(A, 640) }], new Set([A]), [url(B, 320)])).toHaveLength(1);
  });

  it("judges each cancelled photo on its own evidence", () => {
    const problems = unprovenCancellations(
      [
        { id: A, url: url(A, 640) },
        { id: B, url: url(B, 640) },
      ],
      new Set([A, B]),
      [url(A, 320)],
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(B);
  });
});
