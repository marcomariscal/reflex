import { test } from "node:test";
import assert from "node:assert/strict";
import { parseChallenge, stubCredential, parseReceipt, amountUsd, credentialHeader, authorizationValue } from "../src/mpp.ts";

const decode = (s: string) => JSON.parse(Buffer.from(s.replace(/^Payment /, ""), "base64url").toString("utf8"));

// Real 402 from https://mpp.dev/api/ping/paid (the endpoint in mppx's README quick start), captured 2026-10-13.
// request decodes to {"amount":"100000","currency":"0x20c0…0000","methodDetails":{"chainId":42431,"feePayer":true},"recipient":"0xf39F…2266"}
const TEMPO =
  'Payment id="S8p_ELNREghN5c3AjyVclJoan58I2G6FL2ACpoTeiJg", realm="mpp.sh", method="tempo", intent="charge", request="eyJhbW91bnQiOiIxMDAwMDAiLCJjdXJyZW5jeSI6IjB4MjBjMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMCIsIm1ldGhvZERldGFpbHMiOnsiY2hhaW5JZCI6NDI0MzEsImZlZVBheWVyIjp0cnVlfSwicmVjaXBpZW50IjoiMHhmMzlGZDZlNTFhYWQ4OEY2RjRjZTZhQjg4MjcyNzljZmZGYjkyMjY2In0", description="Ping endpoint access", expires="2026-10-13T23:44:49.236Z", opaque="eyJfbXBweF9ub25jZSI6IjB4NWQ4YTU1MDJkNGY4ZDMzY2I2M2E2ZWY4Y2U4ZTY1NTg1MmQ5MWQ4Y2UxZGEyYzQ4MzcxN2I4MjhkNjNhYWU5MyJ9"';

// Stripe challenge from mppx's src/Challenge.test.ts (deserializeList).
const STRIPE =
  'Payment id="k3fGx9QpLmZ2vT8sWyR4nB6cD1eH5jA7uN0iO2aS9dU", realm="example.com", method="stripe", intent="charge", request="eyJhbW91bnQiOiI1MCIsImN1cnJlbmN5IjoidXNkIiwiZXh0ZXJuYWxJZCI6Im9yZGVyLTEyMyIsIm1ldGhvZERldGFpbHMiOnsibmV0d29ya0lkIjoicHJvZmlsZV8wMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwIiwicGF5bWVudE1ldGhvZFR5cGVzIjpbImNhcmQiLCJsaW5rIl19fQ", description="Agentcash card payment test", expires="2026-09-01T00:00:00.000Z", opaque="eyJfbXBweF9zY29wZSI6ImNvZmZlZXNob3A6b3JkZXI6b3JkZXItMTIzOnBheSJ9"';

// Our merchant's stub challenge (merchant/server.ts).
const STUB =
  'Payment id="mrVWXf-QCk9pjxI4g49mEiCrbkHncofDb4x3-wQLSuY", realm="localhost:4021", method="stub", intent="charge", request="eyJhbW91bnQiOiIxMDAwMCIsImN1cnJlbmN5IjoiVVNEIiwiZGVjaW1hbHMiOjYsInJlY2lwaWVudCI6IjB4NWVhN2MwZGUwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMSJ9", description="Web search", expires="2026-10-13T23:48:45.117Z", opaque="eyJub25jZSI6IjFjY2U5YjZhOWVmZWFkY2FlZGVlMGY1Y2VkNmFkNmE2In0"';

test("parses a real tempo challenge (decimals default 6, chainId from methodDetails)", () => {
  const c = parseChallenge(TEMPO);
  assert.deepEqual(c, {
    id: "S8p_ELNREghN5c3AjyVclJoan58I2G6FL2ACpoTeiJg",
    realm: "mpp.sh",
    method: "tempo",
    intent: "charge",
    amount: "100000",
    decimals: 6,
    currency: "0x20c0000000000000000000000000000000000000",
    recipient: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    chainId: 42431,
    expires: "2026-10-13T23:44:49.236Z",
    raw: TEMPO,
  });
  assert.equal(amountUsd(c), 0.1);
});

test("parses our stub challenge", () => {
  const c = parseChallenge(STUB);
  assert.equal(c.method, "stub");
  assert.equal(c.amount, "10000");
  assert.equal(c.currency, "USD");
  assert.equal(c.recipient, "0x5ea7c0de00000000000000000000000000000001");
  assert.equal(c.chainId, null);
  assert.equal(amountUsd(c), 0.01);
  assert.equal(c.raw, STUB);
});

test("picks the tempo challenge out of a merged multi-scheme header; raw stays untouched", () => {
  const merged = `Bearer realm="api", error_description="use Payment, please", ${STRIPE}, ${TEMPO}`;
  const c = parseChallenge(merged);
  assert.equal(c.method, "tempo");
  assert.equal(c.id, "S8p_ELNREghN5c3AjyVclJoan58I2G6FL2ACpoTeiJg");
  assert.equal(c.raw, merged);
  assert.equal(credentialHeader(c), "Authorization");
});

test("honors a non-default credential header", () => {
  const c = parseChallenge(`${STUB}, header="Payment-Authorization"`);
  assert.equal(credentialHeader(c), "Payment-Authorization");
  assert.equal(authorizationValue("abc"), "Payment abc");
  assert.equal(authorizationValue("Payment abc"), "Payment abc");
});

test("parses a live challenge from https://mpp.dev/api/ping/paid", async (t) => {
  let res: Response;
  try {
    res = await fetch("https://mpp.dev/api/ping/paid", { signal: AbortSignal.timeout(8000) });
  } catch {
    return t.skip("offline");
  }
  assert.equal(res.status, 402);
  const c = parseChallenge(res.headers.get("www-authenticate")!);
  assert.equal(c.method, "tempo");
  assert.equal(c.intent, "charge");
  assert.match(c.amount, /^\d+$/);
  assert.equal(c.decimals, 6);
  assert.match(c.recipient, /^0x[0-9a-f]{40}$/);
  assert.equal(typeof c.chainId, "number");
});

test("rejects headers without a Payment challenge or with a bad amount", () => {
  assert.throws(() => parseChallenge('Bearer realm="api"'), /No Payment schemes/);
  const bad = Buffer.from(JSON.stringify({ amount: "1.5", currency: "USD", recipient: "0x1" })).toString("base64url");
  assert.throws(() => parseChallenge(`Payment id="a", realm="r", method="stub", intent="charge", request="${bad}"`), /bad amount/);
});

test("bypass stub credential: echoes the challenge, refuses real methods", () => {
  const cred = decode(stubCredential(parseChallenge(STUB), "bypass-1"));
  assert.equal(cred.challenge.id, "mrVWXf-QCk9pjxI4g49mEiCrbkHncofDb4x3-wQLSuY");
  assert.equal(cred.challenge.method, "stub");
  assert.deepEqual(cred.payload, { type: "stub", signature: "stub-bypass-1" });
  assert.throws(() => stubCredential(parseChallenge(TEMPO), "x"), /Bypass refused/);
});

test("parses a Payment-Receipt header", () => {
  const r = Buffer.from(JSON.stringify({ method: "tempo", reference: "0xabc", status: "success", timestamp: "t" })).toString("base64url");
  assert.equal(parseReceipt(r)?.reference, "0xabc");
  assert.equal(parseReceipt("%%%"), null);
  assert.equal(parseReceipt(null), null);
});
