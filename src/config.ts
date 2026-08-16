import { raise } from './diagnostics.js'

export type BodyMode = 'parse' | 'raw' | 'none'

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T

export interface PropsConfig {
  separator?: string
  assign?: string
  quote?: string
}

export interface SyntaxConfig {
  open: string
  close?: string
}

export interface NodeConfig {
  body?: BodyMode
  syntax?: SyntaxConfig
  props?: PropsConfig
}

export interface DefaultsConfig {
  props?: PropsConfig
}

export interface JzayMarkConfig {
  defaults?: DefaultsConfig
  nodes: Record<string, NodeConfig>
}

export interface ResolvedPropsConfig {
  separator: string
  assign: string
  quote: string
}

export interface ResolvedSyntaxConfig {
  open: string
  close?: string
  system: boolean
}

export interface ResolvedNodeConfig {
  name: string
  body: BodyMode
  syntax: ResolvedSyntaxConfig
  props: ResolvedPropsConfig
}

export interface ResolvedJzayMarkConfig {
  defaults: { props: ResolvedPropsConfig }
  nodes: Record<string, ResolvedNodeConfig>
  orderedNodes: readonly ResolvedNodeConfig[]
}

const NODE_NAME = /^[A-Za-z][A-Za-z0-9_.:-]*$/
const PROPS_TOKEN = '{props}'

export const BUILTIN_NODE_TYPES = new Set([
  'document', 'text', 'paragraph', 'heading', 'blockquote', 'thematicBreak', 'break',
  'emphasis', 'strong', 'delete', 'code', 'inlineCode', 'link', 'image', 'list',
  'listItem', 'definition', 'linkReference', 'imageReference', 'footnoteDefinition',
  'footnoteReference', 'table', 'tableRow', 'tableCell',
])

export const SYSTEM_PROPS: Readonly<ResolvedPropsConfig> = Object.freeze({
  separator: ' ',
  assign: '=',
  quote: '"',
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function dictionary<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value as DeepReadonly<T>
}

function assertOnlyKeys(value: Record<string, unknown>, keys: string[], path: string): void {
  const unknown = Object.keys(value).find((key) => !keys.includes(key))
  if (unknown) raise('INVALID_CONFIG', `${path} 不支持字段 ${unknown}`)
}

function readToken(value: unknown, fallback: string, path: string, single = false): string {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.length === 0 || (single && [...value].length !== 1)) {
    raise('INVALID_CONFIG', `${path} 必须是${single ? '单个' : ''}非空字符串`)
  }
  return value
}

function resolveProps(value: unknown, fallback: ResolvedPropsConfig, path: string): ResolvedPropsConfig {
  if (value === undefined) return { ...fallback }
  if (!isRecord(value)) raise('INVALID_CONFIG', `${path} 必须是对象`)
  assertOnlyKeys(value, ['separator', 'assign', 'quote'], path)
  const result = {
    separator: readToken(value.separator, fallback.separator, `${path}.separator`, true),
    assign: readToken(value.assign, fallback.assign, `${path}.assign`, true),
    quote: readToken(value.quote, fallback.quote, `${path}.quote`, true),
  }
  if (result.separator === result.assign || result.separator === result.quote || result.assign === result.quote) {
    raise('INVALID_CONFIG', `${path} 的 separator、assign 和 quote 不能相同`)
  }
  if (Object.values(result).includes('\\')) {
    raise('INVALID_CONFIG', `${path} 不能使用反斜杠作为属性定界符`)
  }
  if (/\s/u.test(result.assign) || /\s/u.test(result.quote)) {
    raise('INVALID_CONFIG', `${path} 的 assign 和 quote 不能是空白字符`)
  }
  return result
}

function systemSyntax(name: string, body: BodyMode): ResolvedSyntaxConfig {
  return {
    open: `<${name} {props}>`,
    ...(body === 'none' ? {} : { close: `</${name}>` }),
    system: true,
  }
}

function resolveSyntax(value: unknown, name: string, body: BodyMode): ResolvedSyntaxConfig {
  if (value === undefined) return systemSyntax(name, body)
  if (!isRecord(value)) raise('INVALID_CONFIG', `nodes.${name}.syntax 必须是对象`)
  assertOnlyKeys(value, ['open', 'close'], `nodes.${name}.syntax`)
  if (typeof value.open !== 'string' || value.open.length === 0) {
    raise('INVALID_CONFIG', `nodes.${name}.syntax.open 必须是非空字符串`)
  }
  if (value.open.startsWith('\\')) {
    raise('INVALID_CONFIG', `nodes.${name}.syntax.open 不能以反斜杠开头`)
  }
  if (/[\r\n]/u.test(value.open)) {
    raise('INVALID_CONFIG', `nodes.${name}.syntax.open 不能包含换行`)
  }
  const tokenCount = value.open.split(PROPS_TOKEN).length - 1
  if (tokenCount > 1) raise('INVALID_CONFIG', `nodes.${name}.syntax.open 只能包含一个 ${PROPS_TOKEN}`)
  if (tokenCount === 1) {
    const tokenAt = value.open.indexOf(PROPS_TOKEN)
    if (tokenAt === 0 || tokenAt + PROPS_TOKEN.length === value.open.length) {
      raise('INVALID_CONFIG', `nodes.${name}.syntax.open 中 ${PROPS_TOKEN} 前后都必须有固定语法`)
    }
  }
  if (body === 'none') {
    if (value.close !== undefined) raise('INVALID_CONFIG', `body 为 none 的节点 ${name} 不能设置 syntax.close`)
    return { open: value.open, system: false }
  }
  if (typeof value.close !== 'string' || value.close.length === 0) {
    raise('INVALID_CONFIG', `nodes.${name}.syntax.close 必须是非空字符串`)
  }
  if (value.close.startsWith('\\')) {
    raise('INVALID_CONFIG', `nodes.${name}.syntax.close 不能以反斜杠开头`)
  }
  if (/[\r\n]/u.test(value.close)) {
    raise('INVALID_CONFIG', `nodes.${name}.syntax.close 不能包含换行`)
  }
  if (value.close.includes(PROPS_TOKEN)) {
    raise('INVALID_CONFIG', `nodes.${name}.syntax.close 不能包含 ${PROPS_TOKEN}`)
  }
  if (value.open === value.close) raise('INVALID_CONFIG', `节点 ${name} 的 syntax.open 和 syntax.close 不能相同`)
  if (value.open.startsWith(value.close)) {
    raise('INVALID_CONFIG', `节点 ${name} 的 syntax.close 不能是 syntax.open 的前缀`)
  }
  return { open: value.open, close: value.close, system: false }
}

const emptyConfig: Readonly<ResolvedJzayMarkConfig> = deepFreeze({
  defaults: { props: { ...SYSTEM_PROPS } },
  nodes: dictionary<ResolvedNodeConfig>(),
  orderedNodes: [],
})

let activeConfig = emptyConfig

export function configure(config: JzayMarkConfig): DeepReadonly<JzayMarkConfig> {
  if (!isRecord(config) || !isRecord(config.nodes)) {
    raise('INVALID_CONFIG', 'configure() 需要 nodes 配置表')
  }
  assertOnlyKeys(config, ['defaults', 'nodes'], 'configure()')

  let defaultProps = { ...SYSTEM_PROPS }
  if (config.defaults !== undefined) {
    if (!isRecord(config.defaults)) raise('INVALID_CONFIG', 'defaults 必须是对象')
    assertOnlyKeys(config.defaults, ['props'], 'defaults')
    defaultProps = resolveProps(config.defaults.props, defaultProps, 'defaults.props')
  }

  const nodes = dictionary<ResolvedNodeConfig>()
  const orderedNodes: ResolvedNodeConfig[] = []
  for (const [name, value] of Object.entries(config.nodes)) {
    if (!NODE_NAME.test(name)) raise('INVALID_CONFIG', `节点名 ${JSON.stringify(name)} 无效`)
    if (BUILTIN_NODE_TYPES.has(name)) {
      raise('INVALID_CONFIG', `节点名 ${JSON.stringify(name)} 与标准 AST 节点冲突`)
    }
    if (!isRecord(value)) raise('INVALID_CONFIG', `nodes.${name} 必须是对象`)
    assertOnlyKeys(value, ['body', 'syntax', 'props'], `nodes.${name}`)
    if (value.body !== undefined && !['parse', 'raw', 'none'].includes(String(value.body))) {
      raise('INVALID_CONFIG', `节点 ${name} 的 body 必须是 parse、raw 或 none`)
    }
    const body = (value.body as BodyMode | undefined) ?? 'raw'
    const definition: ResolvedNodeConfig = {
      name,
      body,
      syntax: resolveSyntax(value.syntax, name, body),
      props: resolveProps(value.props, defaultProps, `nodes.${name}.props`),
    }
    nodes[name] = definition
    orderedNodes.push(definition)
  }

  activeConfig = deepFreeze({
    defaults: { props: defaultProps },
    nodes,
    orderedNodes,
  })
  const publicNodes = dictionary<NodeConfig>()
  for (const definition of orderedNodes) {
    publicNodes[definition.name] = {
      body: definition.body,
      syntax: {
        open: definition.syntax.open,
        ...(definition.syntax.close ? { close: definition.syntax.close } : {}),
      },
      props: { ...definition.props },
    }
  }
  return deepFreeze({
    defaults: { props: { ...defaultProps } },
    nodes: publicNodes,
  })
}

export function getConfig(): Readonly<ResolvedJzayMarkConfig> {
  return activeConfig
}
