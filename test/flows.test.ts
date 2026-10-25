/**
 * The buy and fetch flows end to end against a stub x402git and a stub Horizon. The
 * signer records what it was asked to sign and returns a fake transaction, so the
 * assertions are about the protocol: which entry was chosen, what the paying request
 * carried, what happened to the bytes.
 */

import { createHash } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { describe, expect, it } from "vitest";
import { CliError } from "../src/errors.js";
import { verifySep53 } from "../src/sep53.js";
import { buy, fetchOwned, type PaymentSigner } from "../src/x402git.js";

const BASE = "https://x402git.test";
const HORIZON = "https://horizon.test";
const KEY = Keypair.fromSecret("SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X");
const PAYER = KEY.publicKey();
const USDC_T = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const USDC_ISSUER_T = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const PAY_TO = "GD6ROJBYLKQMOW3E7N4M2YBPUHMZD7PL65VRHRMO24BOVSBV5H3BQRSL";
const ZIP = new TextEncoder().encode("PK\u0003\u0004 the artifact");
const SHA = createHash("sha256").update(ZIP).digest("hex");
const TX = "d81ef36ab9ba519d82351d1b5b93b52cb22406d7780472e9e0b27890373a4d11";

const evmAccept = {
  scheme: "exact",
  network: "eip155:84532",
  amount: "2000000",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0x1111111111111111111111111111111111111111",
  maxTimeoutSeconds: 300,
  extra: { name: "USDC", version: "2" },
  maxAmountRequired: "2000000",
  resource: `${BASE}/api/r/adrian/humanizer`,
  description: "adrian/humanizer v1.2.0. $2.00 in USDC on Base Sepolia.",
  mimeType: "application/zip",
};
const stellarAccept = (asset = USDC_T) => ({
  scheme: "exact",
  network: "stellar:testnet",
  amount: "20000000",
  asset,
  payTo: PAY_TO,
  maxTimeoutSeconds: 300,
  extra: { areFeesSponsored: true },
  maxAmountRequired: "20000000",
  resource: `${BASE}/api/r/adrian/humanizer`,
  description: "adrian/humanizer v1.2.0. $2.00 in USDC on Stellar testnet.",
  mimeType: "application/zip",
});

function body402(accepts: unknown[]) {
  return {
    x402Version: 2,
    resource: { url: `${BASE}/api/r/adrian/humanizer`, description: "adrian/humanizer v1.2.0", mimeType: "application/zip", serviceName: "adrian/humanizer" },
    accepts,
    extensions: { bazaar: { info: { input: { type: "http", method: "GET" } }, schema: {} } },
    extra: { kind: "new", quote_id: "q_abc123", instructions: "This is an x402 paywall, not an error." },
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

type Seen = { paid: Request | null; challenges: number; versionReq: Request | null; fetchReq: Request | null };

/** A stub deployment. `balance` is the payer's USDC trustline; null means no trustline. */
function stubServer(opts: { accepts?: unknown[]; balance?: string | null; paidAnswer?: () => Response; download?: Uint8Array; owned?: string | null } = {}) {
  const seen: Seen = { paid: null, challenges: 0, versionReq: null, fetchReq: null };
  const accepts = opts.accepts ?? [evmAccept, stellarAccept()];
  const balance = opts.balance === undefined ? "5.0000000" : opts.balance;
  const grant = { version: "1.2.0", artifact_sha256: SHA, download_url: "https://storage.test/adrian/humanizer/1.2.0.zip?signed=1", expires_at: "2026-10-25T18:00:00Z" };
  const nonces = new Map<string, string>();

  const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    const url = new URL(req.url);

    if (url.origin === HORIZON) {
      if (!url.pathname.endsWith(`/accounts/${PAYER}`)) return json(404, { status: 404 });
      const balances: unknown[] = [{ asset_type: "native", balance: "9999.0000000" }];
      if (balance !== null) balances.unshift({ asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: USDC_ISSUER_T, balance, is_authorized: true });
      return json(200, { id: PAYER, balances });
    }

    if (url.href.startsWith("https://storage.test/")) return new Response(opts.download ?? ZIP, { status: 200 });

    if (url.pathname === "/api/auth/challenge") {
      seen.challenges += 1;
      const address = url.searchParams.get("address")!;
      const nonce = `n${seen.challenges}`;
      const message = `x402git wallet_ownership ${address} ${nonce}`;
      nonces.set(nonce, message);
      return json(200, { nonce, message, expires_at: "2026-10-25T18:05:00Z", address });
    }

    /** FR-20 as the server does it: parse, look the nonce up, verify SEP-53, consume. */
    const wallet = (): string | null => {
      const header = req.headers.get("x-wallet-signature");
      if (!header) return null;
      const [address, nonce, sig] = header.split(".");
      const message = nonces.get(nonce);
      if (!message || !verifySep53({ message, signer: address, signatureB64: sig })) throw new Error("bad wallet signature");
      nonces.delete(nonce);
      return address;
    };

    if (url.pathname === "/api/v/adrian/humanizer") {
      seen.versionReq = req;
      const w = wallet();
      return json(200, { owner: "adrian", slug: "humanizer", latest: "1.3.0", price_micro: "2000000", ...(w ? { owned: opts.owned === undefined ? "1.2.0" : opts.owned, entitled: false } : {}) });
    }

    if (url.pathname.startsWith("/api/r/adrian/humanizer/v/")) {
      seen.fetchReq = req;
      const w = wallet();
      if (!w) return json(401, { code: "invalid_signature", message: "This route requires an X-Wallet-Signature header." });
      if (w !== PAYER) return json(403, { code: "not_entitled", message: "This wallet does not own that version." });
      return json(200, { ...grant, version: url.pathname.split("/").pop() });
    }

    if (url.pathname === "/api/r/adrian/humanizer") {
      if (!req.headers.get("payment-signature")) return json(402, body402(accepts));
      seen.paid = req;
      if (opts.paidAnswer) return opts.paidAnswer();
      return json(200, grant, { "payment-response": Buffer.from(JSON.stringify({ success: true, transaction: TX, network: "stellar:testnet", payer: PAYER }), "utf8").toString("base64") });
    }

    return json(404, { code: "not_found", message: "No such route." });
  };

  return { fetchImpl, seen };
}

function recordingSigner() {
  const calls: { requirement: unknown; network: string }[] = [];
  const signer: PaymentSigner = {
    async sign(requirement, network) {
      calls.push({ requirement, network });
      return { transaction: "AAAAAgAAAAD...fake-xdr" };
    },
  };
  return { signer, calls };
}

function files() {
  const written = new Map<string, Uint8Array>();
  return { written, writeFile: async (path: string, bytes: Uint8Array) => void written.set(path, bytes) };
}

function run(server: ReturnType<typeof stubServer>, overrides: Partial<Parameters<typeof buy>[0]> = {}) {
  const { signer, calls } = recordingSigner();
  const disk = files();
  const promise = buy({
    baseUrl: BASE,
    owner: "adrian",
    slug: "humanizer",
    keypair: KEY,
    signer,
    network: "stellar:testnet",
    fetch: server.fetchImpl,
    horizonUrl: { "stellar:testnet": HORIZON },
    writeFile: disk.writeFile,
    outDir: "/out",
    ...overrides,
  });
  return { promise, calls, disk };
}

async function failure(p: Promise<unknown>): Promise<CliError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CliError) return e;
    throw e;
  }
  throw new Error("expected a CliError");
}

describe("buy", () => {
  it("pays the Stellar entry (second in accepts), echoing the quote, the accepted entry, resource and extensions", async () => {
    const server = stubServer();
    const { promise, calls, disk } = run(server);
    const result = await promise;

    // The signer saw the canonical Stellar requirement and only that.
    expect(calls).toHaveLength(1);
    expect(calls[0].network).toBe("stellar:testnet");
    expect(calls[0].requirement).toEqual({
      scheme: "exact",
      network: "stellar:testnet",
      amount: "20000000",
      asset: USDC_T,
      payTo: PAY_TO,
      maxTimeoutSeconds: 300,
      extra: { areFeesSponsored: true },
    });

    // The paying request: PAYMENT-SIGNATURE and X-Quote-Id, with the payload assembled the way the skill asks.
    const paid = server.seen.paid!;
    expect(paid.headers.get("x-quote-id")).toBe("q_abc123");
    const payload = decodePaymentSignatureHeader(paid.headers.get("payment-signature")!) as Record<string, any>;
    expect(payload.x402Version).toBe(2);
    expect(payload.accepted).toEqual(calls[0].requirement);
    expect(payload.payload).toEqual({ transaction: "AAAAAgAAAAD...fake-xdr" });
    expect(payload.resource.url).toBe(`${BASE}/api/r/adrian/humanizer`);
    expect(payload.extensions.bazaar).toBeDefined();

    // The bytes were verified and written; the tx link points at testnet.
    expect(result.kind).toBe("paid");
    expect(result.txHash).toBe(TX);
    expect(result.txUrl).toBe(`https://stellar.expert/explorer/testnet/tx/${TX}`);
    expect(result.asset?.symbol).toBe("USDC");
    expect(result.priceStroops).toBe(20000000n);
    expect(result.path).toBe("/out/adrian-humanizer-v1.2.0.zip");
    expect(disk.written.get(result.path)).toEqual(ZIP);
  });

  it("refuses a Base-only listing before signing, naming the options that exist (exit 2)", async () => {
    const server = stubServer({ accepts: [evmAccept] });
    const { promise, calls } = run(server);
    const e = await failure(promise);
    expect(e.exit).toBe(2);
    expect(e.code).toBe("no_stellar_option");
    expect(e.message).toContain("eip155:84532");
    expect(calls).toHaveLength(0);
    expect(server.seen.paid).toBeNull();
  });

  it("refuses a token it cannot name before signing (exit 2), and allows it when the env says so", async () => {
    const mystery = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
    const server = stubServer({ accepts: [stellarAccept(mystery)] });
    const e = await failure(run(server).promise);
    expect(e.exit).toBe(2);
    expect(e.code).toBe("unknown_asset");
    expect(e.message).toContain(mystery);
    expect(server.seen.paid).toBeNull();

    // Allowed by env, with its own symbol and the issuer the stub's trustline carries.
    const allowed = run(stubServer({ accepts: [stellarAccept(mystery)] }), { assetEnv: `${mystery}:USDC:${USDC_ISSUER_T}` });
    const result = await allowed.promise;
    expect(result.asset?.symbol).toBe("USDC");
    expect(allowed.calls).toHaveLength(1);
  });

  it("says 'this account holds $X, the price is $Y' and signs nothing when the balance is short (exit 3)", async () => {
    const server = stubServer({ balance: "1.5000000" });
    const { promise, calls } = run(server);
    const e = await failure(promise);
    expect(e.exit).toBe(3);
    expect(e.message).toBe("This account holds $1.50, the price is $2.00. Nothing was signed.");
    expect(calls).toHaveLength(0);
    expect(server.seen.paid).toBeNull();
  });

  it("explains a missing trustline in wallet words and signs nothing (exit 2)", async () => {
    const server = stubServer({ balance: null });
    const { promise, calls } = run(server);
    const e = await failure(promise);
    expect(e.exit).toBe(2);
    expect(e.code).toBe("no_trustline");
    expect(e.message).toContain("has not allowed USDC");
    expect(e.hint).toContain("Manage assets");
    expect(e.hint).toContain(USDC_ISSUER_T);
    expect(calls).toHaveLength(0);
  });

  it("writes nothing when the download does not match artifact_sha256 (exit 4)", async () => {
    const server = stubServer({ download: new TextEncoder().encode("not the bytes that were scanned") });
    const { promise, disk } = run(server);
    const e = await failure(promise);
    expect(e.exit).toBe(4);
    expect(e.code).toBe("sha256_mismatch");
    expect(disk.written.size).toBe(0);
  });

  it("reports a 402 after paying as what it is: the price changed, nothing charged (exit 4)", async () => {
    const server = stubServer({ paidAnswer: () => json(409, { code: "price_changed", message: "The price changed since this quote was issued." }) });
    const e = await failure(run(server).promise);
    expect(e.exit).toBe(4);
    expect(e.code).toBe("price_changed");
    expect(e.message).toContain("Nothing was charged");
  });

  it("maps the server's insufficient_balance to exit 3 and a facilitator failure to exit 4", async () => {
    const short = await failure(run(stubServer({ paidAnswer: () => json(402, { code: "insufficient_balance", message: "no" }) })).promise);
    expect(short.exit).toBe(3);
    expect(short.message).toContain("holds $5.00, the price is $2.00");

    const pending = await failure(run(stubServer({ paidAnswer: () => json(504, { code: "settlement_timeout", message: "Settlement did not confirm in time." }) })).promise);
    expect(pending.exit).toBe(4);
    expect(pending.message).toContain("may have moved");
    expect(pending.hint).toContain("fetch adrian/humanizer");

    const again = await failure(run(stubServer({ paidAnswer: () => json(402, body402([stellarAccept()])) })).promise);
    expect(again.exit).toBe(4);
    expect(again.code).toBe("payment_unread");
  });

  it("is a 5 for a listing that does not exist, and never asks the signer", async () => {
    const server = stubServer();
    const { promise, calls } = run(server, { slug: "nope" });
    const e = await failure(promise);
    expect(e.exit).toBe(5);
    expect(calls).toHaveLength(0);
  });
});

describe("fetch — re-download with a SEP-53 wallet signature", () => {
  it("signs a fresh challenge per request and gets the owned version back", async () => {
    const server = stubServer();
    const disk = files();
    const result = await fetchOwned({ baseUrl: BASE, owner: "adrian", slug: "humanizer", keypair: KEY, version: null, fetch: server.fetchImpl, writeFile: disk.writeFile, outDir: "/out" });

    expect(server.seen.challenges).toBe(2); // one for /api/v, one for /api/r/…/v/…
    const header = server.seen.fetchReq!.headers.get("x-wallet-signature")!;
    const [address, nonce, sig] = header.split(".");
    expect(address).toBe(PAYER);
    expect(nonce).toBe("n2");
    expect(Keypair.fromPublicKey(PAYER).verifyMessage(`x402git wallet_ownership ${PAYER} n2`, Buffer.from(sig, "base64"))).toBe(true);
    expect(server.seen.paid).toBeNull();

    expect(result.version).toBe("1.2.0");
    expect(disk.written.get("/out/adrian-humanizer-v1.2.0.zip")).toEqual(ZIP);
  });

  it("takes --version literally and skips the version lookup", async () => {
    const server = stubServer();
    const disk = files();
    const result = await fetchOwned({ baseUrl: BASE, owner: "adrian", slug: "humanizer", keypair: KEY, version: "1.1.0", fetch: server.fetchImpl, writeFile: disk.writeFile, outDir: "/out" });
    expect(server.seen.challenges).toBe(1);
    expect(server.seen.versionReq).toBeNull();
    expect(result.version).toBe("1.1.0");
  });

  it("is a 5 when this key owns nothing here", async () => {
    const server = stubServer({ owned: null });
    const e = await failure(fetchOwned({ baseUrl: BASE, owner: "adrian", slug: "humanizer", keypair: KEY, version: null, fetch: server.fetchImpl, writeFile: files().writeFile }));
    expect(e.exit).toBe(5);
    expect(e.code).toBe("not_owned");
  });

  it("is a 5 (not_entitled) when the version belongs to another key", async () => {
    const other = Keypair.random();
    const server = stubServer();
    const e = await failure(fetchOwned({ baseUrl: BASE, owner: "adrian", slug: "humanizer", keypair: other, version: "1.2.0", fetch: server.fetchImpl, writeFile: files().writeFile }));
    expect(e.exit).toBe(5);
    expect(e.code).toBe("not_entitled");
  });
});
