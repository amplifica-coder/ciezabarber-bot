export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode = 500,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class WebhookSignatureError extends AppError {
  constructor() {
    super("Firma de webhook inválida", "invalid_signature", 401);
  }
}
