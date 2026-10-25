import { describe, expect, it } from "vitest";
import { contractIdOf, KNOWN_ASSETS, parseAssetSpec, resolveAsset } from "../src/assets.js";

const USDT0 = "CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF";
const MYSTERY = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

describe("the asset table", () => {
  it("names exactly the four contracts, each derived from its code and issuer on its network", () => {
    expect(KNOWN_ASSETS).toHaveLength(4);
    for (const a of KNOWN_ASSETS) {
      expect(a.issuer, a.symbol).not.toBeNull();
      expect(contractIdOf(a.code, a.issuer!, a.network), a.symbol).toBe(a.contract);
    }
  });

  it("knows USDT0 on pubnet by its SAC and calls it USDT0", () => {
    const d = resolveAsset(USDT0, "stellar:pubnet");
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.asset.symbol).toBe("USDT0");
      expect(d.asset.issuer).toBe("GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q");
    }
  });

  it("labels the testnet stand-in so nobody reads it as the real token", () => {
    const d = resolveAsset("CA5HAM7BFUSFV6HRLNP2HLMZS5F2TTHFA37PWV3ZUXQFREAY3DYKYF72", "stellar:testnet");
    expect(d.ok && d.asset.symbol).toBe("USDT0 (testnet mock)");
  });

  it("is keyed on network too: pubnet USDT0 is not a testnet asset", () => {
    expect(resolveAsset(USDT0, "stellar:testnet").ok).toBe(false);
  });
});

describe("the asset gate", () => {
  it("refuses a contract it cannot name, and says how to allow it", () => {
    const d = resolveAsset(MYSTERY, "stellar:testnet");
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.reason).toBe("unknown");
      expect(d.message).toContain(MYSTERY);
      expect(d.message).toContain("X402GIT_STELLAR_ASSET=");
      expect(d.message).toContain("Nothing was signed");
    }
  });

  it("allows one more token from X402GIT_STELLAR_ASSET, with its symbol and optional issuer", () => {
    const d = resolveAsset(MYSTERY, "stellar:testnet", { env: `${MYSTERY}:TEST:GDJSXY37UYEOBH4RM77NVLBYN5NGWXE6B52YBCJUOKCJFPPPZI3CZE2M` });
    expect(d.ok).toBe(true);
    if (d.ok) {
      expect(d.asset.symbol).toBe("TEST");
      expect(d.asset.issuer).toBe("GDJSXY37UYEOBH4RM77NVLBYN5NGWXE6B52YBCJUOKCJFPPPZI3CZE2M");
      expect(d.asset.source).toBe("env");
    }
  });

  it("an env value for a different contract does not open the gate", () => {
    expect(resolveAsset(MYSTERY, "stellar:testnet", { env: `${USDT0}:USDT0` }).ok).toBe(false);
  });

  it("--asset allows the contract it names, and refuses a listing that wants another", () => {
    expect(resolveAsset(MYSTERY, "stellar:testnet", { flag: MYSTERY }).ok).toBe(true);
    const d = resolveAsset(USDT0, "stellar:testnet", { flag: MYSTERY });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe("flag_mismatch");
  });

  it("parses the spec strictly: a non-contract is null, a missing symbol is the address", () => {
    expect(parseAssetSpec("GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q:X", "stellar:pubnet", "env")).toBeNull();
    expect(parseAssetSpec(MYSTERY, "stellar:testnet", "flag")?.symbol).toBe(MYSTERY);
    expect(parseAssetSpec(`${MYSTERY}:T:not-an-issuer`, "stellar:testnet", "flag")?.issuer).toBeNull();
  });
});
