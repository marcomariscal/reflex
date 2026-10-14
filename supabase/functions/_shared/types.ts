// Shapes from CONTRACT.md.

export type Challenge = {
  id: string;
  realm: string;
  method: string;
  intent: string;
  amount: string; // base units, decimal string
  decimals: number;
  currency: string;
  recipient: string; // 0x address, lowercased
  chainId: number | null;
  expires: string | null; // ISO
  raw: string; // full WWW-Authenticate header value
};

export type Check = {
  name: "cap" | "payee" | "amount" | "velocity";
  pass: boolean;
  detail: string;
};
