/**
 * sep53.ts — signing a challenge message with a Stellar key (SEP-53).
 *
 * x402git proves a buyer's wallet with `X-Wallet-Signature: <address>.<nonce>.<sig>`
 * over a single-use challenge message. An EVM wallet signs it with EIP-191; a Stellar
 * key signs it with SEP-53: ed25519 over `SHA256("Stellar Signed Message:\n" + message)`.
 * The server verifies with `Keypair.fromPublicKey(G).verifyMessage(message, sig)` from
 * `@stellar/stellar-sdk` 16, and `Keypair.signMessage` here is its exact inverse. The
 * digest is spelled out as well so a test can hold the two to the same bytes.
 */

import { createHash } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";

export const SEP53_PREFIX = "Stellar Signed Message:\n";

/** `SHA256(prefix || message)`, the bytes ed25519 signs. */
export function sep53Digest(message: string): Buffer {
  return createHash("sha256").update(Buffer.from(SEP53_PREFIX + message, "utf8")).digest();
}

/** The base64 SEP-53 signature of `message` by `keypair`. */
export function signSep53(keypair: Keypair, message: string): string {
  return Buffer.from(keypair.signMessage(message)).toString("base64");
}

/** The server's check, for the tests and for anyone verifying what this CLI sent. */
export function verifySep53(input: { message: string; signer: string; signatureB64: string }): boolean {
  try {
    return Keypair.fromPublicKey(input.signer).verifyMessage(input.message, Buffer.from(input.signatureB64, "base64"));
  } catch {
    return false;
  }
}

/** `<G address>.<nonce>.<base64 signature>`, the `X-Wallet-Signature` value. */
export function walletSignatureHeader(address: string, nonce: string, signatureB64: string): string {
  return `${address}.${nonce}.${signatureB64}`;
}
