import assert from "node:assert/strict";
import test from "node:test";
import { conditionalGet } from "../src/api.ts";

test("conditional workspace requests retain data on a 304", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let request: RequestInit | undefined;
  globalThis.fetch = async (_input, init) => {
    request = init;
    return new Response(null, {
      status: 304,
      headers: { etag: '"workspace-12"' },
    });
  };

  const result = await conditionalGet("/workspace?view=dashboard", '"workspace-11"');

  assert.equal(new Headers(request?.headers).get("if-none-match"), '"workspace-11"');
  assert.deepEqual(result, {
    etag: '"workspace-12"',
    unchanged: true,
  });
});

test("conditional workspace requests return changed data and its ETag", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify({ generation: 4 }), {
    status: 200,
    headers: { "content-type": "application/json", etag: '"workspace-4"' },
  });

  assert.deepEqual(await conditionalGet<{ generation: number }>("/workspace"), {
    data: { generation: 4 },
    etag: '"workspace-4"',
    unchanged: false,
  });
});
