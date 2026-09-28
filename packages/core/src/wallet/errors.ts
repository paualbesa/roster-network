export class WalletProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletProviderError";
  }
}
