export class SanitizerEmptyOutputError extends Error {
  constructor(public rawOutput: string, public modifications: string[]) {
    super('sanitizer produced empty output');
    this.name = 'SanitizerEmptyOutputError';
  }
}

export class WebhookSecretMismatchError extends Error {
  constructor() {
    super('webhook secret mismatch');
    this.name = 'WebhookSecretMismatchError';
  }
}

export class SalonNotFoundError extends Error {
  constructor(public ghlLocationId: string) {
    super(`salon not found for location ${ghlLocationId}`);
    this.name = 'SalonNotFoundError';
  }
}
