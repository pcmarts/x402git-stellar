/**
 * x402git.ts — the three things this package does against an x402git deployment.
 *
 *   buy        GET /api/r/:owner/:slug → read the 402 → pick the Stellar entry → check the
 *              token and the balance → sign with the stock `@x402/stellar` client → GET
 *              again with PAYMENT-SIGNATURE and X-Quote-Id → download → verify the sha256.
 *   fetchOwned GET /api/auth/challenge → sign it (SEP-53) → GET /api/r/:owner/:slug/v/:version
 *              with X-Wallet-Signature. Free, forever, for a version this key bought.
 *   whoami     the key's address and what its account holds, from Horizon.
 *
 * Everything that touches the network goes through an injectable `fetch`, and the
 * payment signer is an interface, so the tests run the whole flow against a stub server
 * and a signer that records what it was asked to sign. Nothing here reads `process`:
 * the CLI resolves the environment and hands values in, and the secret is handed in as
 * a `Keypair`, never printed, never put in a URL.
 */

import { Keypair } from "@stellar/stellar-sdk";
import { decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { type Accept, canonicalRequirement, selectAccept } from "./accepts.js";
import { decimalToStroops, dollars, parseAmount } from "./amounts.js";
import { type KnownAsset, resolveAsset } from "./assets.js";
import { CliError } from "./errors.js";
import { type AccountState, type FetchLike, findTrustline, loadAccount } from "./horizon.js";
import { accountUrl, NETWORKS, type StellarNetwork, txUrl } from "./networks.js";
import { signSep53, walletSignatureHeader } from "./sep53.js";
import { matchesSha256 } from "./sha.js";

export type Logger = (line: string) => void;

/** Signs one x402 `exact` Stellar payment. The real one wraps `ExactStellarScheme`. */
export type PaymentSigner = {
  sign(requirement: PaymentRequirements, network: StellarNetwork): Promise<Record<string, unknown>>;
};

export type Deps = {
  fetch?: FetchLike;
  log?: Logger;
  /** Where the zip goes. Default: the current directory. */
  outDir?: string;
  /** Replaced in tests so nothing touches the disk. */
  writeFile?: (path: string, bytes: Uint8Array) => Promise<void>;
  /** Overrides Horizon per network (a local mirror, a test stub). */
  horizonUrl?: Partial<Record<StellarNetwork, string>>;
};

export type BuyInput = Deps & {
  baseUrl: string;
  owner: string;
  slug: string;
  keypair: Keypair;
  signer: PaymentSigner;
  /** The network this key pays on, or null to take the one Stellar network the 402 offers. */
  network: StellarNetwork | null;
  /** `X402GIT_STELLAR_ASSET` and `--asset`, verbatim. */
  assetEnv?: string | null;
  assetFlag?: string | null;
};

export type Grant = {
  version: string;
  artifact_sha256: string;
  download_url: string;
  expires_at?: string;
  [key: string]: unknown;
};

export type BuyResult = {
  kind: "paid" | "free" | "owned";
  version: string;
  sha256: string;
  path: string;
  payer: string;
  network: StellarNetwork | null;
  asset: KnownAsset | null;
  priceStroops: bigint | null;
  txHash: string | null;
  txUrl: string | null;
};

type ErrorBody = { code?: string; message?: string; details?: Record<string, unknown> };

const JSON_HEADERS = { accept: "application/json" };

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const body = (await res.json()) as unknown;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function listingRef(owner: string, slug: string): string {
  return `${owner}/${slug}`;
}

/** The `not_found` / `retired` / `no_release` family, as one sentence each. */
function unavailable(status: number, body: ErrorBody, ref: string): CliError {
  const code = body.code ?? `http_${status}`;
  if (status === 404 || code === "not_found") return new CliError("not_found", 5, `No listing ${ref} on this server (${code}).`);
  if (code === "retired") return new CliError("retired", 5, `${ref} is no longer sold. Anyone who bought it can still run \`fetch\`.`);
  if (code === "no_release") return new CliError("no_release", 5, `${ref} has no release that passed the security scan yet.`);
  if (code === "blocked_jurisdiction") return new CliError(code, 2, body.message ?? "This server does not sell to your location.");
  if (code === "rate_limited") return new CliError(code, 1, body.message ?? "Rate limited. Try again in a minute.");
  return new CliError(code, 1, body.message ?? `The server answered ${status}.`);
}

/** After a payment was attached. The money may or may not have moved; each message says. */
function afterPaying(status: number, body: ErrorBody, ctx: { ref: string; network: StellarNetwork; payer: string; held: string; price: string }): CliError {
  const code = body.code;
  const where = accountUrl(ctx.network, ctx.payer);
  if (code === "insufficient_balance") {
    return new CliError(code, 3, `This account holds ${ctx.held}, the price is ${ctx.price}. Nothing was charged.`, `Top up ${ctx.payer} and run buy again.`);
  }
  if (code === "price_changed") {
    return new CliError(code, 4, "The price changed between the quote and the payment. Nothing was charged.", "Run buy again to be quoted the new price.");
  }
  if (code === "settlement_pending" || code === "settlement_timeout") {
    return new CliError(
      code,
      4,
      `The payment was verified but settlement did not confirm (${code}). The money may have moved.`,
      `Check ${where}, then run \`x402git-stellar fetch ${ctx.ref}\` before paying again: a settled payment already owns the version.`,
    );
  }
  if (code === "expired_authorization") return new CliError(code, 4, "The signed payment expired before it settled. Nothing was charged.", "Run buy again.");
  if (code === "replay") return new CliError(code, 4, "This payment was already used. If it settled, `fetch` re-downloads it for free.", `Check ${where}.`);
  if (code === "authorization_mismatch") return new CliError(code, 4, body.message ?? "The payment did not match the listing.", "Nothing was charged.");
  if (code === "sanctioned_counterparty") return new CliError(code, 2, body.message ?? "This address cannot pay here.");
  if (!code && status === 402) {
    return new CliError("payment_unread", 4, "The server answered 402 again: it did not read the payment that was attached. Nothing was charged.");
  }
  if (status >= 500) return new CliError(code ?? "facilitator", 4, body.message ?? `The server or its facilitator failed (${status}).`, `Check ${where} before paying again.`);
  return new CliError(code ?? `http_${status}`, 4, body.message ?? `The paid request failed with ${status}.`);
}

function horizonFor(network: StellarNetwork, deps: Deps): string {
  return deps.horizonUrl?.[network] ?? NETWORKS[network].horizonUrl;
}

/** Download, verify, write. The file is written only when the bytes hash to what was sold. */
async function download(grant: Grant, ref: string, deps: Required<Pick<Deps, "fetch" | "outDir" | "writeFile">>): Promise<{ path: string; sha256: string }> {
  const res = await deps.fetch(grant.download_url);
  if (!res.ok) throw new CliError("download_failed", 4, `The download URL answered ${res.status}. The purchase stands; run \`x402git-stellar fetch ${ref}\` for a fresh link.`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!matchesSha256(bytes, grant.artifact_sha256)) {
    throw new CliError("sha256_mismatch", 4, `The download does not match artifact_sha256 ${grant.artifact_sha256}. Nothing was written.`, "The purchase stands; run `fetch` to download again.");
  }
  const [owner, slug] = ref.split("/");
  const path = `${deps.outDir.replace(/\/+$/, "")}/${owner}-${slug}-v${grant.version}.zip`;
  await deps.writeFile(path, bytes);
  return { path, sha256: grant.artifact_sha256 };
}

function asGrant(body: Record<string, unknown>): Grant {
  if (typeof body.version !== "string" || typeof body.download_url !== "string" || typeof body.artifact_sha256 !== "string") {
    throw new CliError("bad_grant", 4, "The server granted access but the body lacks version, artifact_sha256 or download_url.");
  }
  return body as Grant;
}

function withDefaults<T extends Deps>(input: T): T & Required<Pick<Deps, "fetch" | "log" | "outDir" | "writeFile">> {
  return {
    ...input,
    fetch: input.fetch ?? fetch,
    log: input.log ?? (() => {}),
    outDir: input.outDir ?? ".",
    writeFile:
      input.writeFile ??
      (async (path, bytes) => {
        const fs = await import("node:fs/promises");
        await fs.writeFile(path, bytes);
      }),
  };
}

// ---------------------------------------------------------------------------
// buy
// ---------------------------------------------------------------------------

export async function buy(input: BuyInput): Promise<BuyResult> {
  const deps = withDefaults(input);
  const { log } = deps;
  const ref = listingRef(input.owner, input.slug);
  const payer = input.keypair.publicKey();
  const resourceUrl = `${input.baseUrl.replace(/\/+$/, "")}/api/r/${input.owner}/${input.slug}`;

  log(`listing   ${ref}`);
  log(`payer     ${payer}`);

  // 1. The quote.
  const unpaid = await deps.fetch(resourceUrl, { headers: JSON_HEADERS });
  if (unpaid.ok) {
    // FR-24: a $0 listing grants on the first call. Nothing to sign.
    const grant = asGrant(await readJson(unpaid));
    log(`free      v${grant.version} — nothing to pay`);
    const file = await download(grant, ref, deps);
    return { kind: "free", version: grant.version, sha256: file.sha256, path: file.path, payer, network: null, asset: null, priceStroops: null, txHash: null, txUrl: null };
  }
  const body402 = await readJson(unpaid);
  if (unpaid.status !== 402) throw unavailable(unpaid.status, body402 as ErrorBody, ref);

  // 2. The entry this key pays. Never accepts[0].
  const selection = selectAccept(body402.accepts, input.network);
  if (!selection.ok) {
    const options = Array.isArray((body402 as { payment_options?: unknown }).payment_options) ? (body402 as { payment_options: unknown[] }).payment_options : null;
    const hint = options ? `payment_options: ${JSON.stringify(options)}` : selection.offered.length ? `accepts: ${selection.offered.join(", ")}` : null;
    throw new CliError(selection.reason, 2, selection.message, hint);
  }
  const { accept, network } = selection;
  const quoteId = typeof (body402.extra as { quote_id?: unknown } | undefined)?.quote_id === "string" ? ((body402.extra as { quote_id: string }).quote_id as string) : null;
  if (!quoteId) throw new CliError("no_quote_id", 2, "The 402 carries no extra.quote_id; this server is not x402git, or it is misconfigured.");

  // 3. The token. Refuse anything the CLI cannot name.
  const decision = resolveAsset(accept.asset, network, { env: input.assetEnv ?? null, flag: input.assetFlag ?? null });
  if (!decision.ok) throw new CliError(decision.reason === "unknown" ? "unknown_asset" : "asset_mismatch", 2, decision.message);
  const asset = decision.asset;

  const priceStroops = parseAmount(accept.amount);
  if (priceStroops === null) throw new CliError("bad_amount", 2, `The Stellar entry's amount is not a positive integer: ${String(accept.amount)}`);
  const price = dollars(priceStroops);
  log(`network   ${network}`);
  log(`asset     ${asset.symbol}  ${asset.contract}${asset.source !== "table" ? `  (allowed by ${asset.source})` : ""}`);
  log(`price     ${price} in ${asset.symbol}${typeof accept.description === "string" ? `  — ${accept.description}` : ""}`);
  const kind = (body402.extra as { kind?: unknown } | undefined)?.kind;
  if (kind === "update") log(`kind      update — you own an earlier version; this is the update price`);

  // 4. Can this account pay? Read before signing, so a short account never builds a payment.
  const account = await loadAccount(horizonFor(network, deps), payer, deps.fetch);
  if (!account.exists) {
    throw new CliError("account_missing", 2, `${payer} does not exist on ${NETWORKS[network].label} yet. Fund it with a little XLM first${network === "stellar:testnet" ? " (Friendbot: https://friendbot.stellar.org/?addr=" + payer + ")" : ""}.`);
  }
  const line = findTrustline(account, asset);
  if (!line) {
    throw new CliError(
      "no_trustline",
      2,
      `${payer} has not allowed ${asset.symbol} yet, so it cannot hold or send it. Nothing was signed.`,
      asset.issuer
        ? `Allow it once: in Freighter, Manage assets → Add manually → code ${asset.code}, issuer ${asset.issuer}. Or with the Stellar CLI: stellar tx new change-trust --line ${asset.code}:${asset.issuer}`
        : `Allow the asset ${asset.code} in your wallet, then run buy again.`,
    );
  }
  if (line.is_authorized === false) throw new CliError("not_authorized", 2, `${payer}'s ${asset.symbol} trustline is not authorized by the issuer.`);
  const held = decimalToStroops(line.balance);
  log(`balance   ${dollars(held)} ${asset.symbol}`);
  if (held < priceStroops) {
    throw new CliError("insufficient_balance", 3, `This account holds ${dollars(held)}, the price is ${price}. Nothing was signed.`, `Top up ${payer} with ${asset.symbol} and run buy again.`);
  }

  // 5. Sign. The stock client simulates the transfer and signs the auth entry; XLM fees
  //    are the facilitator's (`extra.areFeesSponsored`).
  const requirement = canonicalRequirement(accept);
  let payload: Record<string, unknown>;
  try {
    payload = await input.signer.sign(requirement, network);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/balance|insufficient/i.test(message)) {
      throw new CliError("insufficient_balance", 3, `The payment could not be built: ${message}. This account holds ${dollars(held)}, the price is ${price}.`);
    }
    throw new CliError("sign_failed", 4, `Could not build the Stellar payment: ${message}`, "Usual causes: the RPC is down or wrong (--rpc-url), or the asset contract does not exist on this network.");
  }
  log(`signed    auth entry for ${price} ${asset.symbol} → ${accept.payTo}`);

  // 6. Pay: the same GET, with the payment and the quote it answers. `resource` and
  //    `extensions` are echoed unchanged — that is how the listing gets indexed.
  const paymentPayload: PaymentPayload = {
    x402Version: 2,
    resource: body402.resource as PaymentPayload["resource"],
    accepted: requirement,
    payload,
    ...(body402.extensions && typeof body402.extensions === "object" ? { extensions: body402.extensions as Record<string, unknown> } : {}),
  } as PaymentPayload;
  const paid = await deps.fetch(resourceUrl, {
    headers: { ...JSON_HEADERS, "payment-signature": encodePaymentSignatureHeader(paymentPayload), "x-quote-id": quoteId },
  });
  const paidBody = await readJson(paid);
  if (!paid.ok) throw afterPaying(paid.status, paidBody as ErrorBody, { ref, network, payer, held: dollars(held), price });

  const grant = asGrant(paidBody);
  let txHash: string | null = null;
  const responseHeader = paid.headers.get("payment-response");
  if (responseHeader) {
    try {
      const settlement = decodePaymentResponseHeader(responseHeader) as { transaction?: string };
      if (typeof settlement.transaction === "string" && settlement.transaction) txHash = settlement.transaction;
    } catch {
      txHash = null;
    }
  }
  log(`settled   ${txHash ? txUrl(network, txHash) : "(no PAYMENT-RESPONSE header: a replay or an existing entitlement)"}`);

  // 7. The bytes, verified against the sha256 that was scanned and sold.
  const file = await download(grant, ref, deps);
  return {
    kind: txHash ? "paid" : "owned",
    version: grant.version,
    sha256: file.sha256,
    path: file.path,
    payer,
    network,
    asset,
    priceStroops,
    txHash,
    txUrl: txHash ? txUrl(network, txHash) : null,
  };
}

// ---------------------------------------------------------------------------
// fetch (re-download what this key owns)
// ---------------------------------------------------------------------------

export type FetchInput = Deps & {
  baseUrl: string;
  owner: string;
  slug: string;
  keypair: Keypair;
  /** An exact version, or null for the newest one this key owns. */
  version: string | null;
};

export type FetchResult = { version: string; sha256: string; path: string; payer: string };

/** One single-use `X-Wallet-Signature` value. A fresh challenge per request, as the server requires. */
export async function walletSignature(baseUrl: string, keypair: Keypair, fetchImpl: FetchLike): Promise<string> {
  const address = keypair.publicKey();
  const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/api/auth/challenge?address=${address}&purpose=wallet_ownership`, { headers: JSON_HEADERS });
  const body = await readJson(res);
  if (!res.ok) {
    throw new CliError((body as ErrorBody).code ?? "challenge_failed", 2, (body as ErrorBody).message ?? `The challenge endpoint answered ${res.status}.`, "Does this deployment accept Stellar addresses for X-Wallet-Signature yet?");
  }
  if (typeof body.nonce !== "string" || typeof body.message !== "string") throw new CliError("challenge_malformed", 2, "The challenge has no nonce or message.");
  return walletSignatureHeader(address, body.nonce, signSep53(keypair, body.message));
}

export async function fetchOwned(input: FetchInput): Promise<FetchResult> {
  const deps = withDefaults(input);
  const { log } = deps;
  const ref = listingRef(input.owner, input.slug);
  const base = input.baseUrl.replace(/\/+$/, "");
  const payer = input.keypair.publicKey();
  log(`listing   ${ref}`);
  log(`wallet    ${payer}`);

  let version = input.version;
  if (!version) {
    const res = await deps.fetch(`${base}/api/v/${input.owner}/${input.slug}`, {
      headers: { ...JSON_HEADERS, "x-wallet-signature": await walletSignature(base, input.keypair, deps.fetch) },
    });
    const body = await readJson(res);
    if (!res.ok) throw unavailableOrSignature(res.status, body as ErrorBody, ref);
    if (typeof body.owned !== "string" || !body.owned) {
      throw new CliError("not_owned", 5, `${payer} owns no version of ${ref}.`, "A version bought with another key belongs to that key. Buy with this one: `x402git-stellar buy " + ref + "`.");
    }
    version = body.owned;
    log(`owned     v${version}${typeof body.latest === "string" && body.latest !== version ? `  (latest is v${body.latest}; buy again for the update)` : ""}`);
  }

  const res = await deps.fetch(`${base}/api/r/${input.owner}/${input.slug}/v/${version}`, {
    headers: { ...JSON_HEADERS, "x-wallet-signature": await walletSignature(base, input.keypair, deps.fetch) },
  });
  const body = await readJson(res);
  if (!res.ok) throw unavailableOrSignature(res.status, body as ErrorBody, ref, version);
  const grant = asGrant(body);
  const file = await download(grant, ref, deps);
  return { version: grant.version, sha256: file.sha256, path: file.path, payer };
}

function unavailableOrSignature(status: number, body: ErrorBody, ref: string, version?: string): CliError {
  if (body.code === "not_entitled") return new CliError("not_entitled", 5, `This key does not own ${ref}${version ? ` v${version}` : ""}.`, "Versions belong to the key that paid for them.");
  if (body.code === "invalid_signature" || status === 401) {
    return new CliError("invalid_signature", 2, body.message ?? "The server rejected the wallet signature.", "Each challenge is single-use and expires in five minutes; run the command again. If it persists, this deployment may not accept Stellar wallet signatures yet.");
  }
  return unavailable(status, body, ref);
}

// ---------------------------------------------------------------------------
// whoami
// ---------------------------------------------------------------------------

export type WhoamiInput = Deps & { keypair: Keypair; networks: StellarNetwork[] };
export type WhoamiNetwork = { network: StellarNetwork; label: string; state: AccountState; url: string };

export async function whoami(input: WhoamiInput): Promise<{ address: string; networks: WhoamiNetwork[] }> {
  const deps = withDefaults(input);
  const address = input.keypair.publicKey();
  const networks = await Promise.all(
    input.networks.map(async (network) => ({
      network,
      label: NETWORKS[network].label,
      state: await loadAccount(horizonFor(network, deps), address, deps.fetch),
      url: accountUrl(network, address),
    })),
  );
  return { address, networks };
}

// ---------------------------------------------------------------------------
// the real signer and key handling
// ---------------------------------------------------------------------------

/** The stock `@x402/stellar` client around an ed25519 secret. Loaded lazily: `whoami` and `fetch` never need it. */
export function ed25519PaymentSigner(secret: string, rpcUrl?: string | null): PaymentSigner {
  return {
    async sign(requirement, network) {
      const [{ ExactStellarScheme }, { createEd25519Signer }] = await Promise.all([import("@x402/stellar/exact/client"), import("@x402/stellar")]);
      const signer = createEd25519Signer(secret, network);
      const url = rpcUrl ?? NETWORKS[network].rpcUrl;
      const client = new ExactStellarScheme(signer, { url });
      const signed = await client.createPaymentPayload(2, requirement);
      return signed.payload as Record<string, unknown>;
    },
  };
}

/** `S…` from the environment, or a clear refusal. The value is never echoed. */
export function keypairFromSecret(secret: string | undefined | null, envName = "X402GIT_STELLAR_SECRET"): Keypair {
  if (!secret || secret.trim() === "") {
    throw new CliError("no_secret", 2, `${envName} is not set.`, `export ${envName}=S…   (the secret of the Stellar account that pays; it is read from the environment only, never from an argument)`);
  }
  try {
    return Keypair.fromSecret(secret.trim());
  } catch {
    throw new CliError("bad_secret", 2, `${envName} is not a Stellar secret key (it should start with S and be 56 characters).`);
  }
}

export type { Accept, StellarNetwork, PaymentRequirements };
