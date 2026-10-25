#!/usr/bin/env node
/**
 * cli.ts — `x402git-stellar buy|fetch|whoami`.
 *
 * The key is read from X402GIT_STELLAR_SECRET and nowhere else: never a flag, never an
 * argument, never printed. Everything else is a flag with an environment fallback.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { dollars } from "./amounts.js";
import { KNOWN_ASSETS } from "./assets.js";
import { CliError } from "./errors.js";
import { findTrustline } from "./horizon.js";
import { NETWORKS, parseNetwork, STELLAR_NETWORKS, type StellarNetwork } from "./networks.js";
import { buy, ed25519PaymentSigner, fetchOwned, keypairFromSecret, whoami } from "./x402git.js";

const DEFAULT_BASE_URL = "https://x402git.com";

const HELP = `x402git-stellar — buy and re-download X402 Git listings from a Stellar account

Usage
  x402git-stellar buy   <owner>/<slug>  [--base-url URL] [--network stellar:testnet|stellar:pubnet]
                                        [--asset C…[:SYMBOL]] [--out DIR] [--rpc-url URL]
  x402git-stellar fetch <owner>/<slug>  [--version X.Y.Z] [--base-url URL] [--out DIR]
  x402git-stellar whoami                [--network …]

Environment
  X402GIT_STELLAR_SECRET    S… secret of the paying account. Required for every command. Never an argument.
  X402GIT_STELLAR_NETWORK   stellar:testnet | stellar:pubnet. Optional: buy takes the one Stellar network the listing offers.
  X402GIT_STELLAR_ASSET     C…:SYMBOL[:G…]  one more token the CLI may pay in, beyond USDC and USDT0.
  X402GIT_STELLAR_RPC_URL   Soroban RPC. Defaults: SDF testnet; mainnet.sorobanrpc.com on pubnet.
  X402GIT_BASE_URL          The x402git deployment. Default ${DEFAULT_BASE_URL}.

Exit codes
  0 done · 1 unexpected · 2 refused before signing (no Stellar option, unknown token, no trustline)
  3 the account cannot pay (balance below price) · 4 failed after signing (price changed, facilitator, sha256) · 5 not found / not owned
`;

type Env = Record<string, string | undefined>;

function parseRef(value: string | undefined): { owner: string; slug: string } {
  const m = value ? /^([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)$/i.exec(value.trim()) : null;
  if (!m) throw new CliError("bad_ref", 2, `Expected <owner>/<slug>, got ${value ?? "nothing"}.`, "Example: x402git-stellar buy examples/humanizer");
  return { owner: m[1].toLowerCase(), slug: m[2].toLowerCase() };
}

function networkFrom(flag: string | undefined, env: Env): StellarNetwork | null {
  const raw = flag ?? env.X402GIT_STELLAR_NETWORK;
  if (raw === undefined || raw.trim() === "") return null;
  const parsed = parseNetwork(raw);
  if (!parsed) throw new CliError("bad_network", 2, `--network must be stellar:testnet or stellar:pubnet, got ${raw}.`);
  return parsed;
}

export async function main(argv: string[], env: Env, out: (line: string) => void, err: (line: string) => void): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        "base-url": { type: "string" },
        network: { type: "string" },
        asset: { type: "string" },
        out: { type: "string" },
        "rpc-url": { type: "string" },
        version: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    err(HELP);
    return 2;
  }
  const { values, positionals } = parsed;
  const command = positionals[0];
  if (values.help || !command) {
    out(HELP);
    return values.help ? 0 : 2;
  }

  const baseUrl = (values["base-url"] as string | undefined) ?? env.X402GIT_BASE_URL ?? DEFAULT_BASE_URL;
  const outDir = (values.out as string | undefined) ?? ".";

  try {
    const keypair = keypairFromSecret(env.X402GIT_STELLAR_SECRET);

    if (command === "buy") {
      const ref = parseRef(positionals[1]);
      const network = networkFrom(values.network as string | undefined, env);
      const rpcUrl = (values["rpc-url"] as string | undefined) ?? env.X402GIT_STELLAR_RPC_URL ?? null;
      const result = await buy({
        baseUrl,
        ...ref,
        keypair,
        signer: ed25519PaymentSigner(env.X402GIT_STELLAR_SECRET as string, rpcUrl),
        network,
        assetEnv: env.X402GIT_STELLAR_ASSET ?? null,
        assetFlag: (values.asset as string | undefined) ?? null,
        outDir,
        log: out,
      });
      out("");
      if (result.kind === "free") out(`done      v${result.version} was free; nothing was charged.`);
      else if (result.kind === "owned") out(`done      v${result.version} — this wallet already owned it; nothing new was charged.`);
      else out(`done      paid ${dollars(result.priceStroops ?? 0n)} in ${result.asset?.symbol ?? "the listing's token"} from ${result.payer}`);
      if (result.txUrl) out(`tx        ${result.txUrl}`);
      out(`sha256    ${result.sha256}  (verified)`);
      out(`file      ${result.path}`);
      return 0;
    }

    if (command === "fetch") {
      const ref = parseRef(positionals[1]);
      const result = await fetchOwned({ baseUrl, ...ref, keypair, version: (values.version as string | undefined) ?? null, outDir, log: out });
      out("");
      out(`done      v${result.version} re-downloaded for ${result.payer}; nothing was charged.`);
      out(`sha256    ${result.sha256}  (verified)`);
      out(`file      ${result.path}`);
      return 0;
    }

    if (command === "whoami") {
      const chosen = networkFrom(values.network as string | undefined, env);
      const report = await whoami({ keypair, networks: chosen ? [chosen] : STELLAR_NETWORKS, log: out });
      out(`address   ${report.address}`);
      for (const n of report.networks) {
        out("");
        out(`${n.label} (${n.network})`);
        if (!n.state.exists) {
          out(`  account does not exist yet${n.network === "stellar:testnet" ? ` — fund it: https://friendbot.stellar.org/?addr=${report.address}` : " — send it a little XLM to create it"}`);
          continue;
        }
        out(`  XLM       ${n.state.xlm}`);
        for (const asset of KNOWN_ASSETS.filter((a) => a.network === n.network)) {
          const line = findTrustline(n.state, asset);
          if (line) out(`  ${asset.symbol.padEnd(9)} ${line.balance}${line.is_authorized === false ? "  (not authorized)" : ""}`);
        }
        const other = n.state.balances.filter((b) => b.asset_type !== "native" && !KNOWN_ASSETS.some((a) => a.network === n.network && a.code === b.asset_code && a.issuer === b.asset_issuer));
        for (const b of other) out(`  ${(b.asset_code ?? "?").padEnd(9)} ${b.balance}  (issuer ${b.asset_issuer ?? "?"}; not a token this CLI pays in)`);
        out(`  ${n.url}`);
      }
      return 0;
    }

    err(`Unknown command: ${command}`);
    err(HELP);
    return 2;
  } catch (error) {
    if (error instanceof CliError) {
      err("");
      err(`error     ${error.message}`);
      if (error.hint) err(`          ${error.hint}`);
      err(`          (${error.code}, exit ${error.exit})`);
      return error.exit;
    }
    err(`error     ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

// Run `main` only when this file is the program, not when a test imports it. The entry
// is compared by real path: through `npm link` or a global install, `process.argv[1]` is
// the `bin` symlink (`/opt/homebrew/bin/x402git-stellar`), not `dist/cli.js`, and a name
// check alone made every command exit 0 in silence.
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (typeof entry !== "string") return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return /cli\.(js|ts|mjs)$/.test(entry);
  }
})();

if (invokedDirectly) {
  main(process.argv.slice(2), process.env, (line) => console.log(line), (line) => console.error(line)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
