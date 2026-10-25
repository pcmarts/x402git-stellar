# x402git-stellar

Buy and re-download [X402 Git](https://x402git.com) listings from a Stellar account.
It is the stock [`@x402/stellar`](https://www.npmjs.com/package/@x402/stellar) client
as a command line: you hold a Stellar key and some USDT0, the listing's creator is paid
on Stellar, and `buy` does the whole HTTP 402 exchange, verifies the download against the
sha256 that was scanned, and prints the transaction. Nothing in the signing path is
custom; nothing here ever sees a key except the one you give it in the environment.

MIT. Node 22 or later. Pinned to `@x402/stellar` 2.25.0, `@x402/core` 2.25.0 and
`@stellar/stellar-sdk` 16.4.1.

## The three commands

```
npx x402git-stellar buy    <owner>/<slug>   # pay the listing's Stellar price and download the zip
npx x402git-stellar fetch  <owner>/<slug>   # re-download a version this key already bought — free, forever
npx x402git-stellar whoami                  # the key's address, and what its account holds, on both networks
```

Every command reads the paying key from one environment variable and nowhere else:

```
export X402GIT_STELLAR_SECRET=S…     # the secret of the Stellar account that pays. Never a flag, never printed.
```

### `buy <owner>/<slug>`

1. `GET /api/r/<owner>/<slug>` and read the 402.
2. Pick the `accepts` entry whose `network` is this key's Stellar network. Never
   `accepts[0]`: a listing that takes both Base and Stellar lists Base first.
3. Refuse unless the entry's `asset` is a token the CLI can name (see the table below).
   An agent should never sign a transfer of a token it cannot name.
4. Read the account from Horizon. No trustline for the token, or a balance below the
   price, stops here with a plain sentence ("this account holds $4.90, the price is
   $5.00") and exit code 3. Nothing is signed.
5. Sign the payment with `@x402/stellar`'s `ExactStellarScheme` and `createEd25519Signer`
   (an authorization entry on a Soroban `transfer`; network fees are sponsored, so no XLM
   moves).
6. `GET /api/r/<owner>/<slug>` again with `PAYMENT-SIGNATURE` and `X-Quote-Id`.
7. Download, check the bytes against `artifact_sha256`, write
   `./<owner>-<slug>-v<version>.zip`, print the stellar.expert link.

Flags: `--base-url` (default `https://x402git.com`), `--network stellar:testnet|stellar:pubnet`
(default: the one Stellar network the listing offers), `--asset C…[:SYMBOL]` (allow one
more token for this run), `--out DIR`, `--rpc-url URL`.

### `fetch <owner>/<slug> [--version X.Y.Z]`

Re-download what this key owns, without paying. The CLI asks
`GET /api/auth/challenge?address=<G>&purpose=wallet_ownership`, signs the message with
SEP-53 (`Keypair.signMessage`: ed25519 over `SHA256("Stellar Signed Message:\n" + message)`)
and sends `X-Wallet-Signature: <G>.<nonce>.<base64 signature>` to
`GET /api/r/<owner>/<slug>/v/<version>`. Without `--version` it asks `GET /api/v/…` which
version this key owns first. A version belongs to the key that paid for it.

### `whoami`

Prints the address, then for each network: whether the account exists, its XLM, and its
balance in every token the CLI knows. Pass `--network` to look at one.

## Tokens the CLI will pay in

| Network | Token | Contract (SAC) |
|---|---|---|
| `stellar:pubnet` | USDT0 (Tether, issuer `GATISXX6…HN6Q`) | `CBSJZEIO5C7KC2SF3MKSNXXJSW5G3VTNBX4ATMKUI3B2MR4JKM4R26YF` |
| `stellar:pubnet` | USDC (Circle) | `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` |
| `stellar:testnet` | USDC (Circle testnet) | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |
| `stellar:testnet` | USDT0 (testnet mock) — x402git's own test token | `CA5HAM7BFUSFV6HRLNP2HLMZS5F2TTHFA37PWV3ZUXQFREAY3DYKYF72` |

Each row is derived from its asset code and issuer; the tests prove it. Anything else is
refused with the contract address printed, unless you allow it:

```
export X402GIT_STELLAR_ASSET=C…:SYMBOL[:G…issuer]     # one more token, for a deployment that prices in its own test asset
npx x402git-stellar buy owner/slug --asset C…:SYMBOL   # the same, for one run
```

## Environment

| Variable | Meaning |
|---|---|
| `X402GIT_STELLAR_SECRET` | The paying account's `S…` secret. Required. Read from the environment only. |
| `X402GIT_STELLAR_NETWORK` | `stellar:testnet` or `stellar:pubnet`. Optional for `buy` (the 402 decides when one network is offered). |
| `X402GIT_STELLAR_ASSET` | `C…:SYMBOL[:G…]`: one token beyond the table above. |
| `X402GIT_STELLAR_RPC_URL` | Soroban RPC. Defaults: `https://soroban-testnet.stellar.org`; `https://mainnet.sorobanrpc.com` on pubnet (SDF runs no public mainnet RPC). |
| `X402GIT_BASE_URL` | The x402git deployment. Default `https://x402git.com`. |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Done. |
| 1 | Something unexpected (network down, Horizon unreachable). |
| 2 | Refused before signing: the listing offers no Stellar option (the message lists what it does take), the token is unknown, the account has no trustline, bad input. Nothing was signed. |
| 3 | The account cannot pay: its balance is below the price. Nothing was signed. |
| 4 | Something went wrong after signing: the price changed (nothing charged), the facilitator failed or settlement did not confirm (the money may have moved — the message says where to look), the download did not match its sha256 (nothing written). |
| 5 | Not found: no such listing or version, or this key owns nothing here. |

## Try it on testnet in five minutes

1. Make a key: `stellar keys generate agent --network testnet --fund` (the Stellar CLI),
   then `export X402GIT_STELLAR_SECRET=$(stellar keys secret agent)`. Friendbot has given
   the account 10,000 test XLM.
2. Allow the token the deployment prices in. For testnet USDC:
   `stellar tx new change-trust --source agent --network testnet --line USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`,
   then get some from Circle's faucet (https://faucet.circle.com, Stellar).
3. `npx x402git-stellar whoami --network stellar:testnet` shows the balance.
4. `npx x402git-stellar buy <owner>/<slug> --base-url <the deployment>`.
5. `npx x402git-stellar fetch <owner>/<slug>` gets it again, for free.

## From source

```
npm install
npm run build          # tsup → dist/cli.js, dist/index.js, dist/index.d.ts
npm test               # vitest
node dist/cli.js --help
npm link               # then `x402git-stellar …` anywhere
```

The same code is a library (`import { buy, fetchOwned, selectAccept, resolveAsset, verifySep53 } from "x402git-stellar"`),
with `fetch` and the payment signer injectable, which is how the tests run the whole
flow against a stub server.
