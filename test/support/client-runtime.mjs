/**
 * A React stand-in for rendering the browser half under Node: elements are
 * plain objects, hooks are inert, and boolean state starts true so a hover
 * popover renders its panel on the first pass.
 */

/**
 * Build the stand-in React namespace.
 * @returns {object} React-shaped module.
 */
function createReact() {
  return {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return {
        type,
        props: props ?? {},
        children: children.flat(Number.POSITIVE_INFINITY)
          .filter(child => child !== null && child !== undefined && child !== false),
      }
    },
    useState(initial) {
      return [typeof initial === 'boolean' ? true : initial, () => {}]
    },
    useRef(value) {
      return { current: value }
    },
    useEffect() {},
    useLayoutEffect() {},
    useMemo(factory) {
      return factory()
    },
    useCallback(callback) {
      return callback
    },
  }
}

/** Install the browser globals the client module touches while loading. */
function installGlobals() {
  globalThis.window = {
    innerWidth: 1280,
    innerHeight: 900,
    addEventListener() {},
    removeEventListener() {},
    localStorage: { getItem: () => null, setItem() {} },
  }
  globalThis.document = {
    body: {},
    head: { appendChild() {} },
    getElementById: () => null,
    createElement: () => ({ textContent: '' }),
    addEventListener() {},
    removeEventListener() {},
  }
}

/**
 * Text carrying the Shape of a message: a key, or the key with its parameters.
 * @param {string} key - locale key.
 * @param {object} [params] - interpolation values.
 * @returns {string} readable label.
 */
function label(key, params) {
  if (params === undefined) return key
  return `${key}(${Object.entries(params).map(([name, value]) => `${name}=${value}`).join(',')})`
}

/** A context stand-in that records every component the plugin registers. */
function createContext(registered) {
  /** One scope level: slots and effect registration land in `registered`. */
  const makeScope = () => ({
    get: () => undefined,
    inject: (_deps, callback) => { callback(makeScope()) },
    effect: () => {},
    slots: {
      inject: (_name, callback) => callback(),
      register: (definition, component) => { registered.set(`${definition.name}:${definition.id ?? definition.key ?? ''}`, component) },
    },
    locale: {
      register: () => {},
      bind: () => label,
    },
  })
  return { ...makeScope(), remote: { $mount: async () => {} } }
}

/**
 * Load the browser half once and expose the components it registered.
 * @returns {Promise<{costPill: Function, registered: Map<string, Function>}>} panel seat.
 */
export async function loadClient() {
  installGlobals()
  const registered = new Map()
  const React = createReact()
  const modules = {
    react: React,
    'react-dom': { createPortal: element => element },
    '@deepseek-ai/dsh-client-ui-primitives': { useDismissOnOutsidePointer() {} },
  }
  const loaders = []
  globalThis.window.__ModuleLoader__ = {
    load({ factory }) {
      loaders.push(factory)
    },
  }
  await import('../../client.js')
  const factory = loaders[0]
  if (factory === undefined) throw new Error('client bundle did not register a factory')
  const plugin = factory(name => {
    if (modules[name] === undefined) throw new Error(`unexpected client module: ${name}`)
    return modules[name]
  })
  await plugin.apply(createContext(registered))
  const costPill = registered.get('conversation.composer.dock:cost')
  if (costPill === undefined) throw new Error('cost pill was not registered')
  return { costPill, registered }
}

/**
 * Render one component tree and collect every text node, in document order.
 * @param {object|object[]|string} node - rendered tree.
 * @param {string[]} [out] - accumulator.
 * @returns {string[]} text nodes.
 */
export function texts(node, out = []) {
  if (typeof node === 'string' || typeof node === 'number') out.push(String(node))
  else if (Array.isArray(node)) for (const child of node) texts(child, out)
  else if (node !== null && typeof node === 'object') texts(node.children ?? [], out)
  return out
}

/**
 * Find the first rendered element with one class name.
 * @param {object} node - rendered tree.
 * @param {string} className - wanted class.
 * @returns {object|null} matching element.
 */
export function findByClass(node, className) {
  if (node === null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByClass(child, className)
      if (found !== null) return found
    }
    return null
  }
  if (node.props?.className === className) return node
  return findByClass(node.children ?? [], className)
}

/**
 * Render the composer pill for one host summary.
 * @param {Function} costPill - registered component.
 * @param {object} summary - host session summary.
 * @returns {{tree: object, texts: string[], panel: object|null, panelTexts: string[]}} render result.
 */
export function renderPill(costPill, summary) {
  const tree = costPill({
    useCost: selector => selector({ status: 'ready', value: summary, error: null }),
    refresh: () => {},
    useProjection: () => ({ uncachedInputTokens: 10 }),
    t: label,
    openPage: () => {},
  })
  const panel = tree.children.find(child => child !== null && typeof child === 'object' && child.props?.className === 'dsh-mc-panel') ?? null
  return {
    tree,
    texts: texts(tree),
    panel,
    panelTexts: panel === null ? [] : texts(panel),
  }
}
