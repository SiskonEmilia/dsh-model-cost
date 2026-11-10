/**
 * Module resolve hook for the Host service tests: the plugin imports two DSH
 * packages that live in the Desktop bundle, not in this package's tree, so the
 * test process substitutes minimal stand-ins.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/cordis') {
    return { url: new URL('./cordis-stub.mjs', import.meta.url).href, shortCircuit: true }
  }
  if (specifier === '@deepseek-ai/dsh-typert-protocol') {
    return { url: new URL('./typert-stub.mjs', import.meta.url).href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
