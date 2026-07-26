export class StorageNotConfiguredError extends Error {
  constructor(message: string = 'Storage backend is not configured for this project or instance.') {
    super(message);
    this.name = 'StorageNotConfiguredError';
  }
}
