// Custom error for when an object key does not exist in the backing store.
// Thrown by the storage provider's download() method so callers can
// distinguish "object genuinely missing" from transient platform errors and
// handle it gracefully (e.g. returning an "unavailable" response to the
// frontend instead of surfacing a raw storage backend error message).
export class ObjectNotFoundError extends Error {
  public readonly objectKey: string;
  constructor(key: string) {
    super(`The requested file is no longer available in storage.`);
    this.name = 'ObjectNotFoundError';
    this.objectKey = key;
  }
}
