/** Minimal Typert protocol stand-ins: the service only raises and binds its Remote surface. */
export class RemoteError extends Error {
  /**
   * @param {string} code - machine-readable failure code.
   * @param {string} message - human-readable message.
   * @param {object} details - structured details.
   */
  constructor(code, message, details) {
    super(message)
    this.code = code
    this.details = details
  }
}

/**
 * @param {object} service - owning service.
 * @param {string} name - Remote service name.
 * @returns {object} binding placeholder.
 */
export function bindTypertRemote(service, name) {
  return { service, name }
}
