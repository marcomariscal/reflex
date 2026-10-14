// MPP ("Payment" HTTP auth scheme) helpers for the agent side, on top of mppx's own parser.
// Wire format (draft-ryan-httpauth-payment-01, mppx 0.13):
//   WWW-Authenticate: Payment id="..", realm="..", method="tempo", intent="charge",
//                     request="<base64url JCS JSON>", [description, expires, digest, opaque, header]
//   Authorization:    Payment <base64url JSON { challenge, payload, source? }>
//   Payment-Receipt:  <base64url JSON { status, method, timestamp, reference, ... }>
import { Challenge as MppChallenge, Credential } from "mppx";

export type Challenge = {
  id: string;
  realm: string;
  method: string;
  intent: string;
  amount: string;
  decimals: number;
  currency: string;
  recipient: string;
  chainId: number | null;
  expires: string | null;
  raw: string;
};

export type Receipt = { status: string; method: string; timestamp?: string; reference?: string; [k: string]: unknown };

// TIP-20 stablecoins on Tempo all use 6 decimals, and mppx strips `decimals` from the wire request.
const DEFAULT_DECIMALS = 6;
const SUPPORTED = ["tempo", "stub"];

type Mpp = ReturnType<typeof MppChallenge.deserialize>;

// One header may carry several challenges (e.g. tempo + stripe). Pick a charge we can pay.
function select(header: string): Mpp {
  const all = MppChallenge.deserializeList(header);
  return all.find((c) => SUPPORTED.includes(c.method) && c.intent === "charge") ?? all[0];
}

/** Parse a 402's WWW-Authenticate value into the contract's normalized Challenge. `raw` is the header untouched. */
export function parseChallenge(header: string): Challenge {
  const c = select(header);
  const req = c.request as Record<string, any>;
  const details = (req.methodDetails ?? {}) as Record<string, any>;
  const amount = String(req.amount ?? "");
  if (!/^\d+$/.test(amount)) throw new Error(`Payment challenge has a bad amount: ${JSON.stringify(req.amount)}`);
  const chainId = details.chainId ?? req.chainId;
  return {
    id: c.id,
    realm: c.realm,
    method: c.method,
    intent: c.intent,
    amount,
    decimals: DEFAULT_DECIMALS, // display only; the scorer derives decimals from its own currency list
    currency: String(req.currency ?? ""),
    recipient: String(req.recipient ?? "").toLowerCase(),
    chainId: chainId == null ? null : Number(chainId),
    expires: c.expires ?? null,
    raw: header,
  };
}

function find(c: Challenge): Mpp {
  return MppChallenge.deserializeList(c.raw).find((m) => m.id === c.id) ?? select(c.raw);
}

/** Header the paid retry must use: "Authorization" unless the server set `header=` on the challenge. */
export function credentialHeader(c: Challenge): string {
  return MppChallenge.credentialHeader(find(c));
}

/** Header value for a credential, with or without the "Payment " scheme prefix. */
export function authorizationValue(credential: string): string {
  return /^payment\s+/i.test(credential) ? credential : `Payment ${credential}`;
}

/**
 * Stub credential for the REFLEX_BYPASS control lane. Refuses anything but method "stub",
 * so bypass can never produce a credential that moves real money.
 */
export function stubCredential(c: Challenge, paymentId: string): string {
  if (c.method !== "stub") {
    throw new Error(`Bypass refused: this is a real "${c.method}" payment. Bypass only works for stub payments.`);
  }
  return Credential.serialize({ challenge: find(c), payload: { type: "stub", signature: `stub-${paymentId}` } });
}

/** Lenient Payment-Receipt decode (base64url JSON). */
export function parseReceipt(header: string | null): Receipt | null {
  if (!header) return null;
  try {
    return JSON.parse(Buffer.from(header.trim(), "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export function amountUsd(c: Pick<Challenge, "amount" | "decimals">): number {
  return Number(c.amount) / 10 ** c.decimals;
}

export function fmtUsd(n: number): string {
  return n === 0 || n >= 0.01 ? `$${n.toFixed(2)}` : `$${Number(n.toFixed(6))}`;
}

export function shortAddr(a: string): string {
  return /^0x[0-9a-f]{40}$/i.test(a) ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
