import { test } from "node:test";
import assert from "node:assert/strict";

process.env.PLAYER_A_KEY = "key-alpha-11111111";
process.env.PLAYER_B_KEY = "key-bravo-22222222";

const { playerForKey, playerFromRequest } = await import("../src/lib/auth.ts");

test("keys map to their player", () => {
  assert.equal(playerForKey("key-alpha-11111111"), "A");
  assert.equal(playerForKey("key-bravo-22222222"), "B");
});

test("wrong, empty and near-miss keys are rejected", () => {
  assert.equal(playerForKey(null), null);
  assert.equal(playerForKey(""), null);
  assert.equal(playerForKey("key-alpha-1111111"), null, "prefix of a valid key");
  assert.equal(playerForKey("key-alpha-111111112"), null, "valid key plus a suffix");
  assert.equal(playerForKey("KEY-ALPHA-11111111"), null, "case matters");
});

test("the key is accepted from a header or the query string", () => {
  const withHeader = new Request("https://x.test/api/state", { headers: { "x-hyrox-key": "key-bravo-22222222" } });
  assert.equal(playerFromRequest(withHeader), "B");

  const withQuery = new Request("https://x.test/api/state?k=key-alpha-11111111");
  assert.equal(playerFromRequest(withQuery), "A");

  assert.equal(playerFromRequest(new Request("https://x.test/api/state")), null);
});

test("a bad header falls through to the query string", () => {
  const req = new Request("https://x.test/api/state?k=key-alpha-11111111", {
    headers: { "x-hyrox-key": "nope" },
  });
  assert.equal(playerFromRequest(req), "A");
});

test("with no player keys configured, no request is authorized", () => {
  const a = process.env.PLAYER_A_KEY;
  const b = process.env.PLAYER_B_KEY;
  delete process.env.PLAYER_A_KEY;
  delete process.env.PLAYER_B_KEY;
  try {
    assert.equal(playerForKey("key-alpha-11111111"), null);
    assert.equal(playerForKey(""), null);
  } finally {
    process.env.PLAYER_A_KEY = a;
    process.env.PLAYER_B_KEY = b;
  }
});
