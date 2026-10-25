import { describe, expect, it } from "vitest";
import { canonicalRequirement, selectAccept } from "../src/accepts.js";

const EVM = {
  scheme: "exact",
  network: "eip155:84532",
  amount: "2000000",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0x1111111111111111111111111111111111111111",
  maxTimeoutSeconds: 300,
  extra: { name: "USDC", version: "2" },
  maxAmountRequired: "2000000",
  resource: "https://x402git.test/api/r/adrian/humanizer",
  description: "adrian/humanizer v1.2.0. $2.00 in USDC on Base Sepolia.",
  mimeType: "application/zip",
};
const STELLAR = {
  scheme: "exact",
  network: "stellar:testnet",
  amount: "20000000",
  asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  payTo: "GD6ROJBYLKQMOW3E7N4M2YBPUHMZD7PL65VRHRMO24BOVSBV5H3BQRSL",
  maxTimeoutSeconds: 300,
  extra: { areFeesSponsored: true },
  maxAmountRequired: "20000000",
  resource: "https://x402git.test/api/r/adrian/humanizer",
  description: "adrian/humanizer v1.2.0. $2.00 in USDC on Stellar testnet.",
  mimeType: "application/zip",
};

describe("selectAccept — the entry whose network is ours, never index 0", () => {
  it("picks the stellar:testnet entry when it is second, behind Base", () => {
    const sel = selectAccept([EVM, STELLAR], "stellar:testnet");
    expect(sel.ok).toBe(true);
    if (sel.ok) {
      expect(sel.accept.network).toBe("stellar:testnet");
      expect(sel.network).toBe("stellar:testnet");
    }
  });

  it("takes the one Stellar network on offer when no preference is given", () => {
    const sel = selectAccept([EVM, STELLAR], null);
    expect(sel.ok).toBe(true);
    if (sel.ok) expect(sel.network).toBe("stellar:testnet");
  });

  it("refuses a Base-only listing and names what it does take", () => {
    const sel = selectAccept([EVM], "stellar:testnet");
    expect(sel.ok).toBe(false);
    if (!sel.ok) {
      expect(sel.reason).toBe("no_stellar_option");
      expect(sel.message).toContain("eip155:84532");
      expect(sel.offered).toEqual(["eip155:84532 (0x036CbD53842c5426634e7929541eC2318f3dCF7e)"]);
    }
  });

  it("refuses when the key's network is not the listing's Stellar network", () => {
    const sel = selectAccept([STELLAR], "stellar:pubnet");
    expect(sel.ok).toBe(false);
    if (!sel.ok) {
      expect(sel.reason).toBe("network_mismatch");
      expect(sel.message).toContain("stellar:pubnet");
      expect(sel.message).toContain("stellar:testnet");
    }
  });

  it("asks for --network when two Stellar networks are offered and none is preferred", () => {
    const sel = selectAccept([STELLAR, { ...STELLAR, network: "stellar:pubnet" }], null);
    expect(sel.ok).toBe(false);
    if (!sel.ok) expect(sel.reason).toBe("ambiguous");
  });

  it("ignores entries that are not exact or not well-formed", () => {
    const sel = selectAccept([{ scheme: "upto", network: "stellar:testnet" }, { junk: true }, STELLAR], null);
    expect(sel.ok).toBe(true);
    expect(selectAccept([], null).ok).toBe(false);
    expect(selectAccept("nope", null).ok).toBe(false);
  });
});

describe("canonicalRequirement — the seven fields the facilitator sees", () => {
  it("drops the server's decoration and keeps the canonical fields verbatim", () => {
    expect(canonicalRequirement(STELLAR)).toEqual({
      scheme: "exact",
      network: "stellar:testnet",
      amount: "20000000",
      asset: STELLAR.asset,
      payTo: STELLAR.payTo,
      maxTimeoutSeconds: 300,
      extra: { areFeesSponsored: true },
    });
  });
});
