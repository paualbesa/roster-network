export type RegistryErrorStatus = 400 | 403 | 404 | 409;

export class RegistryError extends Error {
  readonly status: RegistryErrorStatus;
  readonly code: string;

  constructor(status: RegistryErrorStatus, code: string, message: string) {
    super(message);
    this.name = "RegistryError";
    this.status = status;
    this.code = code;
  }
}
