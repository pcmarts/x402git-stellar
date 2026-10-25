/**
 * errors.ts — one error type with an exit code, so the CLI's `main` prints and exits
 * and nothing else has to know about `process`.
 *
 *   0  done
 *   1  something unexpected
 *   2  refused before signing: no Stellar option, unknown asset, no trustline, bad input
 *   3  this account cannot pay: the balance is below the price
 *   4  paid or paying and something went wrong after: price changed, facilitator failed,
 *      sha256 mismatch. Read the message; the money may or may not have moved.
 *   5  not found: no such listing, no such version, or this key owns nothing here
 */

export type ExitCode = 1 | 2 | 3 | 4 | 5;

export class CliError extends Error {
  readonly exit: ExitCode;
  readonly code: string;
  readonly hint: string | null;
  constructor(code: string, exit: ExitCode, message: string, hint: string | null = null) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exit = exit;
    this.hint = hint;
  }
}
