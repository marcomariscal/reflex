import type { Challenge } from "./types.ts";
import type { Signed } from "./signer.ts";
import { Challenge as Mpp } from "npm:mppx@0.13.4";
import { tempo } from "npm:mppx@0.13.4/client";
import { Turnkey } from "npm:@turnkey/sdk-server@8.6.0";
import { createAccount } from "npm:@turnkey/viem@0.14.45";
import { privateKeyToAccount } from "npm:viem@2.57.5/accounts";
import type { LocalAccount } from "npm:viem@2.57.5";

const TESTNET = 42431;
const chainId = Number(Deno.env.get("TEMPO_CHAIN_ID") ?? TESTNET);

const need = (k: string) => {
  const v = Deno.env.get(k);
  if (!v) throw new Error(`missing secret ${k}`);
  return v;
};

// Turnkey when its secrets are set. Otherwise a throwaway dev key, testnet only,
// so the live path can be proven before the Turnkey org exists.
let account: Promise<LocalAccount> | undefined;
function getAccount(): Promise<LocalAccount> {
  account ??= (async () => {
    const org = Deno.env.get("TURNKEY_ORGANIZATION_ID");
    if (org) {
      const tk = new Turnkey({
        apiBaseUrl: "https://api.turnkey.com",
        apiPublicKey: need("TURNKEY_API_PUBLIC_KEY"),
        apiPrivateKey: need("TURNKEY_API_PRIVATE_KEY"),
        defaultOrganizationId: org,
        runtimeOverride: "purejs",
      });
      return await createAccount({ client: tk.apiClient(), organizationId: org, signWith: need("TURNKEY_SIGN_WITH") });
    }
    const dev = Deno.env.get("TEMPO_DEV_PRIVATE_KEY");
    if (dev && chainId === TESTNET) return privateKeyToAccount(dev as `0x${string}`);
    throw new Error("no tempo signer: set TURNKEY_* secrets (or TEMPO_DEV_PRIVATE_KEY on testnet)");
  })();
  // Don't cache a failure: one transient Turnkey error would otherwise fail every later signature.
  account.catch(() => { account = undefined; });
  return account;
}

export async function sign(challenge: Challenge, rawHeader: string, _paymentId: string): Promise<Signed> {
  const ch = Mpp.deserializeList(rawHeader).find((c) => c.id === challenge.id);
  if (!ch || ch.method !== "tempo") throw new Error("challenge not found in raw header");
  const req = ch.request as { amount: string; currency: string; recipient?: string };
  // Sign exactly what was scored: the merchant's raw challenge must match what the agent reported.
  if (
    req.amount !== challenge.amount ||
    req.currency.toLowerCase() !== challenge.currency.toLowerCase() ||
    req.recipient?.toLowerCase() !== challenge.recipient.toLowerCase()
  ) throw new Error("raw challenge does not match the scored payment");
  // expectedRecipients also rejects any split payout to an address we didn't score.
  const credential = await tempo.charge({
    account: await getAccount(),
    // Pull only: we hand back a signed tx and the merchant broadcasts it. A challenge advertising
    // push-only would otherwise make us broadcast from inside the scoring transaction.
    mode: "pull",
    expectedChainId: chainId,
    expectedRecipients: [challenge.recipient as `0x${string}`],
  }).createCredential({ challenge: ch, context: {} });
  return { credential };
}
