/** Minimal Cordis `Service` stand-in: the service only needs the owning context. */
export class Service {
  /**
   * @param {object} ctx - owning context.
   * @param {string} name - service name.
   */
  constructor(ctx, name) {
    this.ctx = ctx
    this.name = name
  }
}
