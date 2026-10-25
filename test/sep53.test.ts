import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { SEP53_PREFIX, sep53Digest, signSep53, verifySep53, walletSignatureHeader } from "../src/sep53.js";

/**
 * A fixed key and a fixed message, with the digest and signature the SDK produced on
 * 25 Oct 2026 (@stellar/stellar-sdk 16.4.1). ed25519 is deterministic, so the signature
 * is a constant: if either value ever changes, the hashing has changed and the server's
 * `verifyMessage` would stop accepting what this CLI sends.
 */
const KEY = Keypair.fromSecret("SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X");
const ADDRESS = "GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57";
const MESSAGE = "Hello, World!";
const DIGEST_HEX = "d52eb59c06bb510d065997ff93077068eed0a486c20215b5e02e1ab0d2ebea5f";
const SIGNATURE_B64 = "HnmC0SAug4QDkf8s7/FCdDUTsYfbOuMq0Rxi8RopUCqZU7Eax23uj+FjWPjfsECf/qLfFfBumZ38zT2c2nE7CQ==";

describe("SEP-53 — Stellar Signed Message", () => {
  it("hashes SHA256(prefix || message) with the exact SEP-53 prefix", () => {
    expect(SEP53_PREFIX).toBe("Stellar Signed Message:\n");
    expect(sep53Digest(MESSAGE).toString("hex")).toBe(DIGEST_HEX);
  });

  it("signs the way the SDK's Keypair.signMessage does — the same bytes the server verifies", () => {
    expect(KEY.publicKey()).toBe(ADDRESS);
    const ours = signSep53(KEY, MESSAGE);
    expect(ours).toBe(SIGNATURE_B64);
    // Deterministic ed25519: signing our digest directly must give the identical signature.
    expect(Buffer.from(KEY.sign(sep53Digest(MESSAGE))).toString("base64")).toBe(SIGNATURE_B64);
    expect(Keypair.fromPublicKey(ADDRESS).verifyMessage(MESSAGE, Buffer.from(ours, "base64"))).toBe(true);
  });

  it("verifies only the right key over the right message", () => {
    expect(verifySep53({ message: MESSAGE, signer: ADDRESS, signatureB64: SIGNATURE_B64 })).toBe(true);
    expect(verifySep53({ message: MESSAGE + "!", signer: ADDRESS, signatureB64: SIGNATURE_B64 })).toBe(false);
    expect(verifySep53({ message: MESSAGE, signer: Keypair.random().publicKey(), signatureB64: SIGNATURE_B64 })).toBe(false);
    expect(verifySep53({ message: MESSAGE, signer: "not-an-address", signatureB64: SIGNATURE_B64 })).toBe(false);
  });

  it("spells the header <G>.<nonce>.<base64>", () => {
    const header = walletSignatureHeader(ADDRESS, "abc123", SIGNATURE_B64);
    expect(header.split(".")).toHaveLength(3);
    expect(header.startsWith(`${ADDRESS}.abc123.`)).toBe(true);
  });
});
