import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { matchesSha256, sha256Hex } from "../src/sha.js";
import { decimalToStroops, dollars, parseAmount, stroopsToDecimal } from "../src/amounts.js";

describe("sha256 check", () => {
  const bytes = new TextEncoder().encode("PK\u0003\u0004 a zip, allegedly");
  const hex = createHash("sha256").update(bytes).digest("hex");

  it("matches the exact hash in either case", () => {
    expect(sha256Hex(bytes)).toBe(hex);
    expect(matchesSha256(bytes, hex)).toBe(true);
    expect(matchesSha256(bytes, hex.toUpperCase())).toBe(true);
  });

  it("fails on a different hash, a short hash, or no hash at all", () => {
    expect(matchesSha256(bytes, hex.replace(/^./, hex[0] === "0" ? "1" : "0"))).toBe(false);
    expect(matchesSha256(bytes, hex.slice(0, 63))).toBe(false);
    expect(matchesSha256(bytes, null)).toBe(false);
    expect(matchesSha256(bytes, undefined)).toBe(false);
  });
});

describe("amounts", () => {
  it("prints stroops as dollars with at least two decimals and no float", () => {
    expect(stroopsToDecimal(20000000n)).toBe("2.00");
    expect(stroopsToDecimal(1000000n)).toBe("0.10");
    expect(stroopsToDecimal(12345678n)).toBe("1.2345678");
    expect(dollars(48980000n)).toBe("$4.898");
  });
  it("reads Horizon balances exactly", () => {
    expect(decimalToStroops("4.8980000")).toBe(48980000n);
    expect(decimalToStroops("5")).toBe(50000000n);
    expect(() => decimalToStroops("abc")).toThrow();
  });
  it("accepts only positive integer amounts off the wire", () => {
    expect(parseAmount("20000000")).toBe(20000000n);
    expect(parseAmount("0")).toBeNull();
    expect(parseAmount("2.0")).toBeNull();
    expect(parseAmount(20000000)).toBeNull();
  });
});
