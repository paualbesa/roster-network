export type SolanaFeeStatus = 400 | 403 | 409 | 502;

export class SolanaFeeError extends Error {
  readonly status: SolanaFeeStatus;
  readonly code: string;

  constructor(status: SolanaFeeStatus, code: string, message: string) {
    super(message);
    this.name = "SolanaFeeError";
    this.status = status;
    this.code = code;
  }
}
