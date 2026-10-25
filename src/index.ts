/**
 * x402git-stellar — buy and re-download X402 Git listings from a Stellar account.
 *
 * The CLI (`x402git-stellar buy|fetch|whoami`) is the product; this module is the same
 * code as a library, for an agent harness that would rather call than shell out.
 */

export { type Accept, canonicalRequirement, selectAccept, type Selection } from "./accepts.js";
export { decimalToStroops, dollars, parseAmount, stroopsToDecimal } from "./amounts.js";
export { type AssetDecision, contractIdOf, type KnownAsset, KNOWN_ASSETS, parseAssetSpec, resolveAsset } from "./assets.js";
export { CliError, type ExitCode } from "./errors.js";
export { type AccountState, findTrustline, type HorizonBalance, loadAccount } from "./horizon.js";
export { accountUrl, isStellarNetwork, type NetworkFacts, NETWORKS, parseNetwork, STELLAR_NETWORKS, type StellarNetwork, txUrl } from "./networks.js";
export { SEP53_PREFIX, sep53Digest, signSep53, verifySep53, walletSignatureHeader } from "./sep53.js";
export { matchesSha256, sha256Hex } from "./sha.js";
export {
  buy,
  type BuyInput,
  type BuyResult,
  ed25519PaymentSigner,
  fetchOwned,
  type FetchInput,
  type FetchResult,
  type Grant,
  keypairFromSecret,
  type PaymentSigner,
  walletSignature,
  whoami,
  type WhoamiInput,
} from "./x402git.js";
