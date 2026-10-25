import { createHash } from "node:crypto";

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** True when `bytes` hash to `expected` (hex, any case). A missing expectation never passes. */
export function matchesSha256(bytes: Uint8Array, expected: unknown): boolean {
  if (typeof expected !== "string" || !/^[0-9a-fA-F]{64}$/.test(expected)) return false;
  return sha256Hex(bytes) === expected.toLowerCase();
}
