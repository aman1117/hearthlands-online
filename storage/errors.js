"use strict";

class StorageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StorageError";
    this.code = code;
  }
}

function storageError(error) {
  return error instanceof StorageError
    ? error
    : new StorageError("STORAGE_FAILURE", "The game database operation failed. No outcome can be assumed; retry the same request.");
}

module.exports = { StorageError, storageError };
