export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const enc = new TextEncoder();

export async function sha256(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Constant-time compare. Empty never matches, so an unset secret denies everyone.
export function safeEq(a: string, b: string): boolean {
  const x = enc.encode(a), y = enc.encode(b);
  if (!x.length || x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

// Run work after the response is sent (Telegram calls), without dropping errors.
export function background(p: Promise<unknown>) {
  const done = p.catch((e) => console.error("background task failed", e));
  // deno-lint-ignore no-explicit-any
  (globalThis as any).EdgeRuntime?.waitUntil?.(done);
}
