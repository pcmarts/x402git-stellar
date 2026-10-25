/**
 * networks.ts — the two Stellar networks this CLI pays on, and how to link to them.
 *
 * CAIP-2 ids are `@x402/stellar`'s (`stellar:testnet`, `stellar:pubnet`; there is no
 * `stellar:mainnet`). SDF runs no public Soroban RPC for pubnet, so the pubnet default
 * is a community endpoint that an operator can override with `--rpc-url` or
 * `X402GIT_STELLAR_RPC_URL`.
 */

import { Networks } from "@stellar/stellar-sdk";

export type StellarNetwork = "stellar:testnet" | "stellar:pubnet";

export type NetworkFacts = {
  passphrase: string;
  horizonUrl: string;
  rpcUrl: string;
  /** stellar.expert, without a trailing slash. */
  explorer: string;
  /** How a person names it: "Stellar" alone is mainnet, the way "Base" is. */
  label: string;
};

export const NETWORKS: Record<StellarNetwork, NetworkFacts> = {
  "stellar:testnet": {
    passphrase: Networks.TESTNET,
    horizonUrl: "https://horizon-testnet.stellar.org",
    rpcUrl: "https://soroban-testnet.stellar.org",
    explorer: "https://stellar.expert/explorer/testnet",
    label: "Stellar testnet",
  },
  "stellar:pubnet": {
    passphrase: Networks.PUBLIC,
    horizonUrl: "https://horizon.stellar.org",
    rpcUrl: "https://mainnet.sorobanrpc.com",
    explorer: "https://stellar.expert/explorer/public",
    label: "Stellar",
  },
};

export const STELLAR_NETWORKS = Object.keys(NETWORKS) as StellarNetwork[];

export function isStellarNetwork(value: unknown): value is StellarNetwork {
  return value === "stellar:testnet" || value === "stellar:pubnet";
}

/** `stellar:testnet`, `testnet`, `pubnet`, `mainnet`, `public` → a CAIP-2 id, or null. */
export function parseNetwork(value: string | undefined | null): StellarNetwork | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v === "stellar:testnet" || v === "testnet") return "stellar:testnet";
  if (v === "stellar:pubnet" || v === "pubnet" || v === "mainnet" || v === "public" || v === "stellar:mainnet") return "stellar:pubnet";
  return null;
}

export function txUrl(network: StellarNetwork, hash: string): string {
  return `${NETWORKS[network].explorer}/tx/${hash}`;
}

export function accountUrl(network: StellarNetwork, address: string): string {
  return `${NETWORKS[network].explorer}/account/${address}`;
}
