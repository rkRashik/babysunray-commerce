// An in-memory stand-in for the parts of Supabase Storage's REST API the media adapter uses, as `fetch`. Fictional data only.
// It records every request so tests can check headers, and lets a test inject failures. No network is ever used.

export type Recorded = { method: string; path: string; headers: Record<string, string>; body?: string };
export type FakeSupabase = {
  fetch: typeof fetch;
  objects: Map<string, { data: Buffer; type: string; updated: string }>;
  requests: Recorded[];
  /** Called before each request; return a Response to answer with it, or throw to simulate a network error. */
  intercept: ((request: Recorded) => Response | undefined) | null;
  bucketPublic: boolean;
  /** Folder placeholders to list (entries with no id). */
  folders: string[];
};

export function fakeSupabase(bucket = "photos"): FakeSupabase {
  const state: FakeSupabase = { objects: new Map(), requests: [], intercept: null, bucketPublic: false, folders: [], fetch: undefined as unknown as typeof fetch };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  state.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init?.body ? Buffer.from(init.body as Uint8Array) : undefined;
    const recorded: Recorded = { method: init?.method ?? "GET", path: url.pathname, headers, body: body?.toString("latin1") };
    state.requests.push(recorded);
    const injected = state.intercept?.(recorded);
    if (injected) return injected;
    const prefix = "/storage/v1/";
    const rest = url.pathname.slice(prefix.length);
    if (rest === `bucket/${bucket}`) return json(200, { id: bucket, name: bucket, public: state.bucketPublic });
    if (rest === `object/list/${bucket}`) {
      const { search = "", limit = 100, offset = 0 } = JSON.parse(String(init?.body)) as { search?: string; limit?: number; offset?: number };
      const names = [...state.objects.keys(), ...state.folders].filter((n) => n.includes(search)).sort();
      return json(
        200,
        names.slice(offset, offset + limit).map((name) => ({ name, id: state.folders.includes(name) ? null : `id-${name}`, updated_at: state.objects.get(name)?.updated ?? null })),
      );
    }
    const authenticated = rest.startsWith(`object/authenticated/${bucket}/`);
    const key = rest.replace(`object/authenticated/${bucket}/`, "").replace(`object/${bucket}/`, "");
    if (authenticated && recorded.method === "GET") {
      const found = state.objects.get(key);
      return found ? new Response(new Uint8Array(found.data), { status: 200, headers: { "content-type": found.type } }) : json(400, { statusCode: "404", error: "not_found" });
    }
    if (rest.startsWith(`object/${bucket}/`) && recorded.method === "POST") {
      if (state.objects.has(key) && headers["x-upsert"] !== "true") return json(400, { statusCode: "409", error: "Duplicate", message: "The resource already exists" });
      state.objects.set(key, { data: body ?? Buffer.alloc(0), type: headers["content-type"], updated: new Date().toISOString() });
      return json(200, { Key: `${bucket}/${key}` });
    }
    if (rest.startsWith(`object/${bucket}/`) && recorded.method === "DELETE") {
      state.objects.delete(key);
      return json(200, { message: "Successfully deleted" });
    }
    return json(404, { error: "not_found" });
  }) as typeof fetch;
  return state;
}
