export class GhlApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: string,
  ) {
    super(`GHL API ${status} on ${path}: ${body.slice(0, 200)}`);
    this.name = 'GhlApiError';
  }
}

export class OutsideMessagingWindowError extends GhlApiError {
  constructor(path: string, body: string) {
    super(422, path, body);
    this.name = 'OutsideMessagingWindowError';
  }
}

export function isOutsideWindowError(status: number, body: string): boolean {
  if (status !== 422 && status !== 400) return false;
  const lower = body.toLowerCase();
  return lower.includes('24') && (lower.includes('window') || lower.includes('messaging'));
}
