export class AttachmentFetchError extends Error {
  constructor(public readonly status: number, public readonly url: string) {
    super(`Attachment fetch failed (status ${status}) for ${url}`);
    this.name = 'AttachmentFetchError';
  }
}

export class UnsupportedImageFormatError extends Error {
  constructor(public readonly format: string) {
    super(`Unsupported image format: ${format}`);
    this.name = 'UnsupportedImageFormatError';
  }
}

export class ImageTooLargeError extends Error {
  constructor(public readonly bytes: number) {
    super(`Image too large: ${bytes} bytes (max 5MB)`);
    this.name = 'ImageTooLargeError';
  }
}
