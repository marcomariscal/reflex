import type { Challenge } from "./types.ts";
import { sign as tempoSign } from "./signer_tempo.ts";

export type Signed = { credential: string; txHash?: string };

// The challenge's payment method picks the signer. Stub credentials only work on
// the local merchant, so they can't move money. `raw` and `challenge.id` pass
// through untouched: the tempo signer re-parses `raw` and picks that id.
export function sign(challenge: Challenge, rawHeader: string, paymentId: string): Promise<Signed> {
  if (challenge.method === "stub") return Promise.resolve(stubSign(challenge, paymentId));
  if (challenge.method === "tempo") return tempoSign(challenge, rawHeader, paymentId);
  return Promise.reject(new Error(`no signer for payment method "${challenge.method}"`));
}

// Contract stub credential: base64url JSON the local merchant accepts for its own challenge ids.
function stubSign(challenge: Challenge, paymentId: string): Signed {
  const body = { challenge: { id: challenge.id }, payload: { type: "stub", signature: `stub-${paymentId}` } };
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(body))));
  return { credential: b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") };
}
