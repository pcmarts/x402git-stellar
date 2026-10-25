/**
 * assets.ts — the tokens this CLI will sign a transfer of, by contract address.
 *
 * An agent should never sign a transfer of a token it cannot name. The 402 names the
 * asset only as a `C…` Stellar Asset Contract address, so the CLI keeps a short table of
 * the contracts it knows (each one derived from its code and issuer; the tests prove
 * the derivation) and refuses anything else unless the operator allows it explicitly:
 *
 *   X402GIT_STELLAR_ASSET=<C…>:<SYMBOL>[:<G issuer>]    one more asset, for a deployment
 *                                                       that prices in its own test token
 *   --asset <C…>[:<SYMBOL>]                             the same, for one run
 *
 * Asset codes are not unique on Stellar, so every known row pins code *and* issuer; the
 * `[:<G issuer>]` suffix on the env value lets the balance check find the right
 * trustline, and without it the check matches on the code alone.
 */

import { Asset } from "@stellar/stellar-sdk";
import { NETWORKS, type StellarNetwork } from "./networks.js";

export type KnownAsset = {
  contract: string;
  network: StellarNetwork;
  /** The classic asset code the trustline carries. */
  code: string;
  /** The issuing account, or null when the operator allowed the contract without naming one. */
  issuer: string | null;
  /** What to print. A test token says so, so nobody mistakes it for the real one. */
  symbol: string;
  /** Where the row came from: the built-in table, the environment, or a flag. */
  source: "table" | "env" | "flag";
};

/** Circle's USDC on both networks, Tether's USDT0 on pubnet, and the x402git test token. */
export const KNOWN_ASSETS: readonly KnownAsset[] = [
  {
    contract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    network: "stellar:testnet",
    code: "USDC",
    issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    symbol: "USDC",
    source: "table",
  },
  {
    contract: "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
    network: "stellar:pubnet",
    code: "USDC",
    issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    symbol: "USDC",
    source: "table",
  },
  {
    contract: "CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF",
    network: "stellar:pubnet",
    code: "USDT0",
    issuer: "GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q",
    symbol: "USDT0",
    source: "table",
  },
  {
    // x402git's own testnet stand-in for USDT0 (there is no USDT0 on testnet). Same
    // code, same path through the CLI, labelled so nobody reads it as the real token.
    contract: "CA5HAM7BFUSFV6HRLNP2HLMZS5F2TTHFA37PWV3ZUXQFREAY3DYKYF72",
    network: "stellar:testnet",
    code: "USDT0",
    issuer: "GDJSXY37UYEOBH4RM77NVLBYN5NGWXE6B52YBCJUOKCJFPPPZI3CZE2M",
    symbol: "USDT0 (testnet mock)",
    source: "table",
  },
];

const CONTRACT = /^C[A-Z2-7]{55}$/;
const ACCOUNT = /^G[A-Z2-7]{55}$/;

/** The SAC address the SDK derives for a code and issuer on a network. */
export function contractIdOf(code: string, issuer: string, network: StellarNetwork): string {
  return new Asset(code, issuer).contractId(NETWORKS[network].passphrase);
}

/** Parse `<C…>:<SYMBOL>[:<G issuer>]`. Returns null for anything malformed. */
export function parseAssetSpec(spec: string | undefined | null, network: StellarNetwork, source: "env" | "flag"): KnownAsset | null {
  if (!spec) return null;
  const parts = spec.trim().split(":");
  const contract = (parts[0] ?? "").toUpperCase();
  if (!CONTRACT.test(contract)) return null;
  const symbol = parts[1] && parts[1].trim() !== "" ? parts[1].trim() : contract;
  const issuer = parts[2] && ACCOUNT.test(parts[2].toUpperCase()) ? parts[2].toUpperCase() : null;
  return { contract, network, code: symbol, issuer, symbol, source };
}

export type AssetDecision = { ok: true; asset: KnownAsset } | { ok: false; reason: "unknown" | "flag_mismatch"; message: string };

/**
 * May the CLI sign a transfer of `contract` on `network`? The table first, then the
 * environment, then the flag. A flag that names a *different* contract than the 402
 * asks for is refused too: the operator allowed one token, the listing wants another.
 */
export function resolveAsset(contract: string, network: StellarNetwork, allow: { env?: string | null; flag?: string | null } = {}): AssetDecision {
  const wanted = contract.toUpperCase();
  const fromFlag = parseAssetSpec(allow.flag, network, "flag");
  if (allow.flag && !fromFlag) {
    return { ok: false, reason: "flag_mismatch", message: `--asset must be <C…>[:<SYMBOL>]; got ${allow.flag}` };
  }
  if (fromFlag && fromFlag.contract !== wanted) {
    return {
      ok: false,
      reason: "flag_mismatch",
      message: `This listing is priced in ${wanted}, but --asset allowed ${fromFlag.contract}. Nothing was signed.`,
    };
  }

  const known = KNOWN_ASSETS.find((a) => a.contract === wanted && a.network === network);
  if (known) return { ok: true, asset: known };

  const fromEnv = parseAssetSpec(allow.env, network, "env");
  if (fromEnv && fromEnv.contract === wanted) return { ok: true, asset: fromEnv };
  if (fromFlag) return { ok: true, asset: fromFlag };

  return {
    ok: false,
    reason: "unknown",
    message:
      `This listing is priced in a token this CLI does not know: ${wanted} on ${network}. ` +
      `It signs transfers only of tokens it can name (USDC, USDT0). To allow this one deliberately, set ` +
      `X402GIT_STELLAR_ASSET=${wanted}:<SYMBOL> or pass --asset ${wanted}:<SYMBOL>. Nothing was signed.`,
  };
}
