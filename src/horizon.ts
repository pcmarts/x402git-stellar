/**
 * horizon.ts — one read of an account from Horizon: does it exist, what does it hold.
 *
 * Horizon's `GET /accounts/{id}` returns classic balances; a Stellar Asset Contract's
 * balance for a `G…` account *is* its trustline balance, so this is also the balance
 * the x402 payment will draw on. No SDK client here: one URL, one JSON body.
 */

export type HorizonBalance = {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
  is_authorized?: boolean;
};

export type AccountState = {
  exists: boolean;
  address: string;
  /** Native XLM, as Horizon prints it, or null for an account that does not exist. */
  xlm: string | null;
  balances: HorizonBalance[];
};

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function loadAccount(horizonUrl: string, address: string, fetchImpl: FetchLike = fetch): Promise<AccountState> {
  const res = await fetchImpl(`${horizonUrl}/accounts/${address}`, { headers: { accept: "application/json" } });
  if (res.status === 404) return { exists: false, address, xlm: null, balances: [] };
  if (!res.ok) throw new Error(`Horizon answered ${res.status} for ${address}`);
  const body = (await res.json()) as { balances?: HorizonBalance[] };
  const balances = Array.isArray(body.balances) ? body.balances : [];
  const native = balances.find((b) => b.asset_type === "native");
  return { exists: true, address, xlm: native?.balance ?? "0", balances };
}

/**
 * The trustline for `code` (and `issuer`, when known), or null when the account has
 * not allowed that asset. Matching on the code alone is for an operator-allowed asset
 * whose issuer was not named; the built-in table always names one.
 */
export function findTrustline(state: AccountState, asset: { code: string; issuer: string | null }): HorizonBalance | null {
  return (
    state.balances.find(
      (b) => b.asset_type !== "native" && b.asset_code === asset.code && (asset.issuer === null || b.asset_issuer === asset.issuer),
    ) ?? null
  );
}
