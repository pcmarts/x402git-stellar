/**
 * accepts.ts — which entry of a 402's `accepts[]` this signer pays.
 *
 * Never index 0. A listing that takes both Base and Stellar lists Base first; a listing
 * that takes Stellar alone lists Stellar first. The only rule that works for both is
 * "the entry whose `network` is the one my key pays on", and that is the whole of this
 * module.
 */

import type { PaymentRequirements } from "@x402/core/types";
import { isStellarNetwork, type StellarNetwork } from "./networks.js";

/** One `accepts[]` entry as the 402 carries it. The seven canonical fields plus whatever the server adds. */
export type Accept = {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown> | null;
  description?: string;
  [key: string]: unknown;
};

export type Selection =
  | { ok: true; accept: Accept; network: StellarNetwork }
  | { ok: false; reason: "no_stellar_option" | "network_mismatch" | "ambiguous" | "malformed"; message: string; offered: string[] };

function isAccept(value: unknown): value is Accept {
  if (!value || typeof value !== "object") return false;
  const a = value as Record<string, unknown>;
  return (
    typeof a.scheme === "string" &&
    typeof a.network === "string" &&
    typeof a.amount === "string" &&
    typeof a.asset === "string" &&
    typeof a.payTo === "string" &&
    typeof a.maxTimeoutSeconds === "number"
  );
}

/** `"eip155:84532 (0x036C…)"`, for the "what this listing does take" line. */
function describe(a: Accept): string {
  return `${a.network} (${a.asset})`;
}

/**
 * Pick the Stellar `exact` entry for `preferred`. With no preference, a 402 that offers
 * exactly one Stellar network decides; two would be ambiguous and the caller is told.
 */
export function selectAccept(accepts: unknown, preferred: StellarNetwork | null): Selection {
  if (!Array.isArray(accepts) || accepts.length === 0) {
    return { ok: false, reason: "malformed", message: "The 402 carries no accepts[] entries.", offered: [] };
  }
  const valid = accepts.filter(isAccept);
  const offered = valid.map(describe);
  const stellar = valid.filter((a) => a.scheme === "exact" && isStellarNetwork(a.network));

  if (stellar.length === 0) {
    return {
      ok: false,
      reason: "no_stellar_option",
      message:
        `This listing offers no Stellar option. It takes: ${offered.join(", ") || "nothing this client reads"}. ` +
        `Its creator is paid on another network; a Base wallet can buy it on the listing page.`,
      offered,
    };
  }

  if (preferred) {
    const match = stellar.find((a) => a.network === preferred);
    if (match) return { ok: true, accept: match, network: preferred };
    return {
      ok: false,
      reason: "network_mismatch",
      message: `Your key is set to pay on ${preferred}, but this listing takes Stellar payments on ${stellar.map((a) => a.network).join(", ")}. Switch with --network or X402GIT_STELLAR_NETWORK.`,
      offered,
    };
  }

  const networks = [...new Set(stellar.map((a) => a.network))];
  if (networks.length > 1) {
    return {
      ok: false,
      reason: "ambiguous",
      message: `This listing takes Stellar payments on ${networks.join(" and ")}. Say which with --network.`,
      offered,
    };
  }
  const accept = stellar[0];
  return { ok: true, accept, network: accept.network as StellarNetwork };
}

/**
 * The seven fields the facilitator is called with, and the ones the client echoes in
 * `accepted`. `@x402/core`'s schema strips everything else, so sending the server's
 * decorated entry back would only be stripped again.
 */
export function canonicalRequirement(accept: Accept): PaymentRequirements {
  return {
    scheme: accept.scheme,
    network: accept.network,
    amount: accept.amount,
    asset: accept.asset,
    payTo: accept.payTo,
    maxTimeoutSeconds: accept.maxTimeoutSeconds,
    extra: (accept.extra ?? undefined) as PaymentRequirements["extra"],
  } as PaymentRequirements;
}
