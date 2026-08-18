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

export interface SyntaxSugarMatch {
  readonly value: string
  readonly index: number
  readonly captures: readonly (string | undefined)[]
  readonly groups: Readonly<Record<string, string | undefined>>
}

export interface SyntaxSugarMapping {
  props?: Record<string, string | true>
  body?: string
}

export type SyntaxSugarMapper = (
  match: SyntaxSugarMatch,
) => SyntaxSugarMapping | null

export interface SyntaxSugarRule {
  match: RegExp
  map: SyntaxSugarMapping | SyntaxSugarMapper
}

export interface NodeConfig {
  body?: BodyMode
  syntax?: SyntaxConfig
  props?: PropsConfig
  syntaxSugar?: SyntaxSugarRule[]
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
  syntaxSugar: readonly ResolvedSyntaxSugarRule[]
}

export interface ResolvedSyntaxSugarRule {
  source: string
  flags: string
  map: SyntaxSugarMapping | SyntaxSugarMapper
  order: number
  path: string
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
  if (value instanceof RegExp) return value as DeepReadonly<T>
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child)
    Object.freeze(value)
  }
  return value as DeepReadonly<T>
}

function validMappedPropKey(key: string, format: ResolvedPropsConfig): boolean {
  if (!key || /[\s\\]/u.test(key) || key.includes(format.assign) || key.includes(format.quote)) return false
  return /^\s+$/u.test(format.separator) || !key.includes(format.separator)
}

function copySyntaxSugarMapping(
  value: unknown,
  path: string,
  body: BodyMode,
  syntax: ResolvedSyntaxConfig,
  propsFormat: ResolvedPropsConfig,
): SyntaxSugarMapping {
  if (!isRecord(value)) raise('INVALID_CONFIG', `${path} 必须是对象或函数`)
  assertOnlyKeys(value, ['props', 'body'], path)
  const result: SyntaxSugarMapping = {}
  if (value.props !== undefined) {
    if (!isRecord(value.props)) raise('INVALID_CONFIG', `${path}.props 必须是对象`)
    const props: Record<string, string | true> = Object.create(null) as Record<string, string | true>
    for (const [key, template] of Object.entries(value.props)) {
      if (!validMappedPropKey(key, propsFormat)) {
        raise('INVALID_CONFIG', `${path}.props 的属性名 ${JSON.stringify(key)} 无法由标准语法输出`)
      }
      if (typeof template !== 'string' && template !== true) {
        raise('INVALID_CONFIG', `${path}.props.${key} 必须是字符串或 true`)
      }
      props[key] = template
    }
    if (Object.keys(props).length > 0 && !syntax.open.includes(PROPS_TOKEN)) {
      raise('INVALID_CONFIG', `${path}.props 生成了属性，但节点的标准语法没有 ${PROPS_TOKEN}`)
    }
    result.props = props
  }
  if (value.body !== undefined) {
    if (body === 'none') raise('INVALID_CONFIG', `${path}.body 不适用于 body 为 none 的节点`)
    if (typeof value.body !== 'string') raise('INVALID_CONFIG', `${path}.body 必须是字符串`)
    result.body = value.body
  }
  return result
}

function canMatchEmpty(source: string, flags: string): boolean {
  const pattern = new RegExp(source, flags.includes('g') ? flags : `${flags}g`)
  for (const sample of ['', 'a', ' ', '\n', '@', '中', '😀']) {
    pattern.lastIndex = 0
    const match = pattern.exec(sample)
    if (match?.[0] === '') return true
  }
  return false
}

function resolveSyntaxSugar(
  value: unknown,
  name: string,
  body: BodyMode,
  syntax: ResolvedSyntaxConfig,
  props: ResolvedPropsConfig,
  startOrder: number,
): ResolvedSyntaxSugarRule[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) raise('INVALID_CONFIG', `nodes.${name}.syntaxSugar 必须是数组`)
  return value.map((rule, index) => {
    const path = `nodes.${name}.syntaxSugar[${index}]`
    if (!isRecord(rule)) raise('INVALID_CONFIG', `${path} 必须是对象`)
    assertOnlyKeys(rule, ['match', 'map'], path)
    if (!(rule.match instanceof RegExp)) raise('INVALID_CONFIG', `${path}.match 必须是正则表达式`)
    if (!rule.match.flags.includes('u')) raise('INVALID_CONFIG', `${path}.match 必须启用 Unicode u 标志`)
    if (rule.match.flags.includes('y')) raise('INVALID_CONFIG', `${path}.match 不能使用 sticky y 标志`)
    if (canMatchEmpty(rule.match.source, rule.match.flags)) {
      raise('INVALID_CONFIG', `${path}.match 不能匹配空字符串`)
    }
    if (rule.map === undefined) raise('INVALID_CONFIG', `${path}.map 是必填字段`)
    const map = typeof rule.map === 'function'
      ? rule.map as SyntaxSugarMapper
      : copySyntaxSugarMapping(rule.map, `${path}.map`, body, syntax, props)
    return {
      source: rule.match.source,
      flags: rule.match.flags,
      map,
      order: startOrder + index,
      path,
    }
  })
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
  let syntaxSugarOrder = 0
  for (const [name, value] of Object.entries(config.nodes)) {
    if (!NODE_NAME.test(name)) raise('INVALID_CONFIG', `节点名 ${JSON.stringify(name)} 无效`)
    if (BUILTIN_NODE_TYPES.has(name)) {
      raise('INVALID_CONFIG', `节点名 ${JSON.stringify(name)} 与标准 AST 节点冲突`)
    }
    if (!isRecord(value)) raise('INVALID_CONFIG', `nodes.${name} 必须是对象`)
    assertOnlyKeys(value, ['body', 'syntax', 'props', 'syntaxSugar'], `nodes.${name}`)
    if (value.body !== undefined && !['parse', 'raw', 'none'].includes(String(value.body))) {
      raise('INVALID_CONFIG', `节点 ${name} 的 body 必须是 parse、raw 或 none`)
    }
    const body = (value.body as BodyMode | undefined) ?? 'raw'
    const syntax = resolveSyntax(value.syntax, name, body)
    const props = resolveProps(value.props, defaultProps, `nodes.${name}.props`)
    const syntaxSugar = resolveSyntaxSugar(value.syntaxSugar, name, body, syntax, props, syntaxSugarOrder)
    syntaxSugarOrder += syntaxSugar.length
    const definition: ResolvedNodeConfig = {
      name,
      body,
      syntax,
      props,
      syntaxSugar,
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
      ...(definition.syntaxSugar.length > 0 ? {
        syntaxSugar: definition.syntaxSugar.map((rule) => ({
          match: new RegExp(rule.source, rule.flags),
          map: rule.map,
        })),
      } : {}),
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
