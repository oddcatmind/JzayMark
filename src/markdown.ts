import type { Root } from 'mdast'
import { unified } from 'unified'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import remarkStringify from 'remark-stringify'
import type { Options as RemarkStringifyOptions } from 'remark-stringify'
import { AST_VERSION, createAst } from './ast.js'
import type { AstVersion, JsonValue, JzayAst, JzayNode, Props } from './ast.js'
import { BUILTIN_NODE_TYPES } from './config.js'
import type {
  ResolvedJzayMarkConfig,
  ResolvedNodeConfig,
  ResolvedPropsConfig,
} from './config.js'
import { JzayMarkError, locationAt, raise } from './diagnostics.js'
import type { InternalMarkdownNode } from './internal-markdown.js'

export type ParseMode = 'normal' | 'loose'

export interface ParseOptions {
  version?: AstVersion
  mode?: ParseMode
}

type MarkdownNode = InternalMarkdownNode

interface ProtectedRange {
  start: number
  end: number
}

interface TokenRecord {
  node: JzayNode
  block: boolean
}

interface ParseContext {
  config: Readonly<ResolvedJzayMarkConfig>
  mode: ParseMode
  prefix: string
  nextToken: number
  protectedRanges: ProtectedRange[]
  tokens: Map<string, TokenRecord>
  blockNodes: WeakSet<JzayNode>
}

interface SyntaxEventBase {
  start: number
  end: number
}

interface OpeningEvent extends SyntaxEventBase {
  kind: 'open'
  definition: ResolvedNodeConfig
  props?: Props
  error?: JzayMarkError
}

interface ClosingEvent extends SyntaxEventBase {
  kind: 'close'
  definition: ResolvedNodeConfig
}

interface TextEvent extends SyntaxEventBase {
  kind: 'text'
  value?: string
}

interface MalformedEvent extends SyntaxEventBase {
  kind: 'malformed'
  definition: ResolvedNodeConfig
  code: 'INVALID_MARKER' | 'UNCLOSED_MARKER'
}

type SyntaxEvent = OpeningEvent | ClosingEvent | TextEvent | MalformedEvent

interface ScanResult {
  markdown: string
  cursor: number
  close?: ClosingEvent
  fallback?: true
}

const BASE_STRINGIFY_OPTIONS = {
  fences: true,
  listItemIndent: 'one',
  resourceLink: true,
} as const satisfies RemarkStringifyOptions

function stringifyProfiles(): RemarkStringifyOptions[] {
  const profiles: RemarkStringifyOptions[] = []
  for (const emphasis of ['*', '_'] as const) {
    for (const bullet of ['-', '+'] as const) {
      for (const fence of ['`', '~'] as const) {
        for (const rule of ['*', '_'] as const) {
          for (const setext of [false, true]) {
            profiles.push({
              ...BASE_STRINGIFY_OPTIONS,
              emphasis,
              strong: emphasis,
              bullet,
              fence,
              rule,
              setext,
            })
          }
        }
      }
    }
  }
  return profiles
}

const markdownProfiles = stringifyProfiles()

function createMarkdownProcessor(options: RemarkStringifyOptions) {
  return unified()
  .use(remarkParse)
  .use(remarkGfm, { singleTilde: false })
  .use(remarkStringify, options)
}

const processor = createMarkdownProcessor(markdownProfiles[0]!)
type MarkdownProcessor = typeof processor
const markdownProcessors: Array<MarkdownProcessor | undefined> = [processor]

function markdownProcessorAt(index: number): MarkdownProcessor {
  const existing = markdownProcessors[index]
  if (existing) return existing
  const created = createMarkdownProcessor(markdownProfiles[index]!)
  markdownProcessors[index] = created
  return created
}

const PHRASING_PARENTS = new Set([
  'paragraph', 'heading', 'emphasis', 'strong', 'delete', 'link', 'linkReference', 'tableCell',
])

type NodePlacement = 'flow' | 'phrasing'

const PHRASING_NODES = new Set([
  'text', 'inlineCode', 'emphasis', 'strong', 'delete', 'link', 'image',
  'linkReference', 'imageReference', 'footnoteReference', 'break',
])

const FLOW_NODES = new Set([
  'paragraph', 'heading', 'blockquote', 'thematicBreak', 'code', 'list', 'definition',
  'footnoteDefinition', 'table',
])

const LIST_ITEM_NODES = new Set(['listItem'])
const TABLE_ROW_NODES = new Set(['tableRow'])
const TABLE_CELL_NODES = new Set(['tableCell'])

function parseMarkdownTree(source: string): MarkdownNode {
  return processor.runSync(processor.parse(source)) as unknown as MarkdownNode
}

function walk(node: MarkdownNode, visit: (node: MarkdownNode) => void): void {
  visit(node)
  for (const child of node.children ?? []) walk(child, visit)
}

function codeRanges(tree: MarkdownNode): ProtectedRange[] {
  const ranges: ProtectedRange[] = []
  walk(tree, (node) => {
    if (node.type !== 'code' && node.type !== 'inlineCode') return
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (typeof start === 'number' && typeof end === 'number') ranges.push({ start, end })
  })
  return ranges.sort((left, right) => left.start - right.start)
}

function rangeAt(ranges: ProtectedRange[], offset: number): ProtectedRange | undefined {
  return ranges.find((range) => offset >= range.start && offset < range.end)
}

function isEscaped(source: string, offset: number): boolean {
  let slashes = 0
  for (let index = offset - 1; index >= 0 && source[index] === '\\'; index -= 1) slashes += 1
  return slashes % 2 === 1
}

function decodeQuoted(value: string, source: string, offset: number): string {
  let result = ''
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (character !== '\\') {
      result += character
      continue
    }
    index += 1
    const escaped = value[index]
    if (escaped === undefined) raise('INVALID_ATTRIBUTE', '属性值不能以反斜杠结尾', locationAt(source, offset))
    result += escaped === 'n' ? '\n' : escaped === 'r' ? '\r' : escaped === 't' ? '\t' : escaped
  }
  return result
}

function splitOutsideQuote(input: string, separator: string, quote: string, source: string, offset: number): string[] {
  const result: string[] = []
  let start = 0
  let cursor = 0
  let quoted = false
  let escaped = false
  const whitespace = /^\s+$/u.test(separator)
  while (cursor < input.length) {
    const character = input[cursor] ?? ''
    if (quoted) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (input.startsWith(quote, cursor)) {
        quoted = false
        cursor += quote.length
        continue
      }
      cursor += 1
      continue
    }
    if (input.startsWith(quote, cursor)) {
      quoted = true
      cursor += quote.length
      continue
    }
    if (whitespace ? /\s/u.test(character) : input.startsWith(separator, cursor)) {
      result.push(input.slice(start, cursor))
      if (whitespace) while (/\s/u.test(input[cursor] ?? '')) cursor += 1
      else cursor += separator.length
      start = cursor
      continue
    }
    cursor += 1
  }
  if (quoted || escaped) raise('INVALID_ATTRIBUTE', '属性值缺少结束引号', locationAt(source, offset))
  result.push(input.slice(start))
  return result
}

function findOutsideQuote(input: string, token: string, quote: string): number {
  let quoted = false
  let escaped = false
  for (let cursor = 0; cursor < input.length; cursor += 1) {
    const character = input[cursor] ?? ''
    if (quoted) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (input.startsWith(quote, cursor)) {
        quoted = false
        cursor += quote.length - 1
      }
      continue
    }
    if (input.startsWith(quote, cursor)) {
      quoted = true
      cursor += quote.length - 1
      continue
    }
    if (input.startsWith(token, cursor)) return cursor
  }
  return -1
}

function validAttributeKey(key: string, format: ResolvedPropsConfig): boolean {
  if (!key || /[\s\\]/u.test(key) || key.includes(format.assign) || key.includes(format.quote)) return false
  return /^\s+$/u.test(format.separator) || !key.includes(format.separator)
}

function readAttributes(
  input: string,
  definition: ResolvedNodeConfig,
  source: string,
  offset: number,
  mode: ParseMode,
): Props | undefined {
  if (!input.trim()) return undefined
  const { separator, assign, quote } = definition.props
  const entries: Array<[string, JsonValue]> = []
  const names = new Set<string>()
  for (const rawEntry of splitOutsideQuote(input.trim(), separator, quote, source, offset)) {
    const entry = rawEntry.trim()
    if (!entry) raise('INVALID_ATTRIBUTE', `节点 ${definition.name} 包含空属性`, locationAt(source, offset))
    const assignAt = findOutsideQuote(entry, assign, quote)
    const key = (assignAt === -1 ? entry : entry.slice(0, assignAt)).trim()
    if (!validAttributeKey(key, definition.props)) {
      raise('INVALID_ATTRIBUTE', `节点 ${definition.name} 的属性名 ${JSON.stringify(key)} 无效`, locationAt(source, offset))
    }
    if (names.has(key)) {
      if (mode === 'loose') continue
      raise('DUPLICATE_ATTRIBUTE', `节点 ${definition.name} 的属性 ${key} 重复`, locationAt(source, offset))
    }
    names.add(key)
    if (assignAt === -1) {
      entries.push([key, true])
      continue
    }
    const rawValue = entry.slice(assignAt + assign.length).trim()
    if (rawValue.length < quote.length * 2 || !rawValue.startsWith(quote) || !rawValue.endsWith(quote)) {
      raise('INVALID_ATTRIBUTE', `节点 ${definition.name} 的属性 ${key} 必须使用 ${quote} 包裹`, locationAt(source, offset))
    }
    entries.push([key, decodeQuoted(rawValue.slice(quote.length, -quote.length), source, offset)])
  }
  return entries.length > 0 ? Object.fromEntries(entries) as Props : undefined
}

function renderOpeningTemplate(template: string, attributes: string): string {
  const tokenAt = template.indexOf('{props}')
  if (tokenAt === -1) return template
  if (attributes) return template.replace('{props}', () => attributes)
  const before = template[tokenAt - 1]
  if (before !== undefined && /\s/u.test(before)) {
    return `${template.slice(0, tokenAt - 1)}${template.slice(tokenAt + 7)}`
  }
  const after = template[tokenAt + 7]
  if (after !== undefined && /\s/u.test(after)) {
    return `${template.slice(0, tokenAt)}${template.slice(tokenAt + 8)}`
  }
  return template.replace('{props}', '')
}

function findSuffix(source: string, cursor: number, suffix: string, quote: string, end: number): number {
  let quoted = false
  let escaped = false
  while (cursor < end) {
    const character = source[cursor] ?? ''
    if (character === '\n' || character === '\r') return -1
    if (quoted) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (source.startsWith(quote, cursor)) {
        quoted = false
        cursor += quote.length
        continue
      }
      cursor += 1
      continue
    }
    if (source.startsWith(quote, cursor)) {
      quoted = true
      cursor += quote.length
      continue
    }
    if (source.startsWith(suffix, cursor)) return cursor
    cursor += 1
  }
  return -1
}

function lineFragmentEnd(source: string, start: number, end: number): number {
  const newline = source.indexOf('\n', start)
  return newline === -1 || newline >= end ? end : newline
}

function openingEvent(
  source: string,
  start: number,
  end: number,
  definition: ResolvedNodeConfig,
  context: ParseContext,
): OpeningEvent | MalformedEvent | undefined {
  const template = definition.syntax.open
  if (definition.syntax.system) {
    const prefix = `<${definition.name}`
    if (!source.startsWith(prefix, start)) return undefined
    const boundary = source[start + prefix.length]
    if (boundary !== '>' && !/\s/u.test(boundary ?? '')) return undefined
    const suffixAt = findSuffix(source, start + prefix.length, '>', definition.props.quote, end)
    if (suffixAt === -1) {
      return {
        kind: 'malformed',
        start,
        end: lineFragmentEnd(source, start, end),
        definition,
        code: 'UNCLOSED_MARKER',
      }
    }
    const eventEnd = suffixAt + 1
    try {
      const props = readAttributes(source.slice(start + prefix.length, suffixAt), definition, source, start, context.mode)
      return { kind: 'open', start, end: eventEnd, definition, ...(props ? { props } : {}) }
    } catch (error) {
      if (context.mode !== 'loose' || !(error instanceof JzayMarkError)) throw error
      return { kind: 'open', start, end: eventEnd, definition, error }
    }
  }

  const empty = renderOpeningTemplate(template, '')
  if (source.startsWith(empty, start)) return { kind: 'open', start, end: start + empty.length, definition }
  const tokenAt = template.indexOf('{props}')
  if (tokenAt === -1) return undefined
  const prefix = template.slice(0, tokenAt)
  const suffix = template.slice(tokenAt + 7)
  if (!source.startsWith(prefix, start)) {
    const stablePrefix = prefix.trimEnd()
    const boundary = source[start + stablePrefix.length]
    if (stablePrefix && source.startsWith(stablePrefix, start) && (boundary === undefined || /\s/u.test(boundary))) {
      return {
        kind: 'malformed',
        start,
        end: lineFragmentEnd(source, start, end),
        definition,
        code: 'UNCLOSED_MARKER',
      }
    }
    return undefined
  }
  const suffixAt = findSuffix(source, start + prefix.length, suffix, definition.props.quote, end)
  if (suffixAt === -1) {
    return {
      kind: 'malformed',
      start,
      end: lineFragmentEnd(source, start, end),
      definition,
      code: 'UNCLOSED_MARKER',
    }
  }
  const eventEnd = suffixAt + suffix.length
  try {
    const props = readAttributes(source.slice(start + prefix.length, suffixAt), definition, source, start, context.mode)
    return { kind: 'open', start, end: eventEnd, definition, ...(props ? { props } : {}) }
  } catch (error) {
    if (context.mode !== 'loose' || !(error instanceof JzayMarkError)) throw error
    return { kind: 'open', start, end: eventEnd, definition, error }
  }
}

function genericTagEnd(source: string, start: number, end: number): number {
  let quote: string | undefined
  let escaped = false
  for (let cursor = start + 1; cursor < end; cursor += 1) {
    const character = source[cursor] ?? ''
    if (character === '\n' || character === '\r') return -1
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = undefined
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '<') return -1
    if (character === '>') return cursor
  }
  return -1
}

function unknownSystemTag(
  source: string,
  start: number,
  end: number,
  context: ParseContext,
): TextEvent | ClosingEvent | MalformedEvent | undefined {
  if (source[start] !== '<') return undefined
  if (source.startsWith('<!--', start)) {
    const closeAt = source.indexOf('-->', start + 4)
    return closeAt === -1 ? undefined : { kind: 'text', start, end: closeAt + 3 }
  }
  if (source.startsWith('<![CDATA[', start)) {
    const closeAt = source.indexOf(']]>', start + 9)
    return closeAt === -1 ? undefined : { kind: 'text', start, end: closeAt + 3 }
  }
  const suffixAt = genericTagEnd(source, start, end)
  if (suffixAt === -1) return undefined
  if (source.startsWith('<!', start) || source.startsWith('<?', start)) {
    return { kind: 'text', start, end: suffixAt + 1 }
  }
  const content = source.slice(start + 1, suffixAt).trim()
  const match = /^(\/)?([A-Za-z][A-Za-z0-9_.:-]*)([\s\S]*)$/u.exec(content)
  if (!match) return undefined
  const definition = context.config.nodes[match[2] ?? '']
  if (definition?.syntax.system) {
    if (match[1] && !(match[3] ?? '').trim()) {
      return { kind: 'close', start, end: suffixAt + 1, definition }
    }
    return { kind: 'malformed', start, end: suffixAt + 1, definition, code: 'INVALID_MARKER' }
  }
  if (!/^\/?[A-Za-z][A-Za-z0-9_.:-]*(?:\s[\s\S]*)?\/?$/u.test(content)) return undefined
  return { kind: 'text', start, end: suffixAt + 1 }
}

function eventAt(
  source: string,
  start: number,
  end: number,
  context: ParseContext,
  expected?: ResolvedNodeConfig,
): SyntaxEvent | undefined {
  if (expected?.syntax.close && source.startsWith(expected.syntax.close, start)) {
    return { kind: 'close', start, end: start + expected.syntax.close.length, definition: expected }
  }
  const definitions = [...context.config.orderedNodes].reverse()
  for (const definition of definitions) {
    if (definition.syntax.close && source.startsWith(definition.syntax.close, start)) {
      return { kind: 'close', start, end: start + definition.syntax.close.length, definition }
    }
    const opening = openingEvent(source, start, end, definition, context)
    if (opening) return opening
  }
  return unknownSystemTag(source, start, end, context)
}

function findNextEvent(
  source: string,
  cursor: number,
  end: number,
  context: ParseContext,
  expected?: ResolvedNodeConfig,
): SyntaxEvent | undefined {
  while (cursor < end) {
    const protectedRange = rangeAt(context.protectedRanges, cursor)
    if (protectedRange) {
      cursor = protectedRange.end
      continue
    }
    if (!isEscaped(source, cursor)) {
      const event = eventAt(source, cursor, end, context, expected)
      if (event) return event
    } else {
      const event = eventAt(source, cursor, end, context, expected)
      if (event) {
        return {
          kind: 'text',
          start: cursor - 1,
          end: event.end,
          value: source.slice(cursor, event.end),
        }
      }
    }
    cursor += 1
  }
  return undefined
}

function isStandalone(source: string, start: number, end: number): boolean {
  const lineStart = source.lastIndexOf('\n', start - 1) + 1
  const nextNewline = source.indexOf('\n', end)
  const lineEnd = nextNewline === -1 ? source.length : nextNewline
  const before = source.slice(lineStart, start)
  const after = source.slice(end, lineEnd)
  const containerPrefix = /^[\t ]*(?:(?:>[\t ]*)|(?:(?:[-+*]|\d+[.)])[\t ]+))*$/
  return containerPrefix.test(before) && /^[\t ]*$/.test(after)
}

function newToken(context: ParseContext, record: TokenRecord): string {
  const token = `${context.prefix}${context.nextToken}Z`
  context.nextToken += 1
  context.tokens.set(token, record)
  if (record.block) context.blockNodes.add(record.node)
  return token
}

function textToken(context: ParseContext, value: string): string {
  return newToken(context, { node: { type: 'text', value }, block: false })
}

function findLiteral(
  source: string,
  cursor: number,
  end: number,
  literal: string,
  context: ParseContext,
  respectProtected = true,
): number {
  let next = source.indexOf(literal, cursor)
  while (next !== -1 && next < end) {
    if (isEscaped(source, next) || (respectProtected && rangeAt(context.protectedRanges, next))) {
      next = source.indexOf(literal, next + literal.length)
      continue
    }
    return next
  }
  return -1
}

function decodeRawValue(value: string, close: string): string {
  let result = ''
  let cursor = 0
  while (cursor < value.length) {
    if (value.startsWith('\\\\', cursor)) {
      result += '\\'
      cursor += 2
      continue
    }
    if (value[cursor] === '\\' && value.startsWith(close, cursor + 1)) {
      result += close
      cursor += close.length + 1
      continue
    }
    result += value[cursor] ?? ''
    cursor += 1
  }
  return result
}

function encodeRawValue(value: string, close: string): string {
  let result = ''
  let cursor = 0
  while (cursor < value.length) {
    if (value[cursor] === '\\') {
      result += '\\\\'
      cursor += 1
      continue
    }
    if (value.startsWith(close, cursor)) {
      result += `\\${close}`
      cursor += close.length
      continue
    }
    result += value[cursor] ?? ''
    cursor += 1
  }
  return result
}

function flowChildren(node: MarkdownNode, context: ParseContext): JzayNode[] {
  const children = fromMarkdownChildren(node, context)
  const result: JzayNode[] = []
  let phrasing: JzayNode[] = []
  const flush = () => {
    if (phrasing.length > 0) result.push({ type: 'paragraph', children: phrasing })
    phrasing = []
  }
  for (const child of children) {
    if (PHRASING_NODES.has(child.type)) phrasing.push(child)
    else {
      flush()
      result.push(child)
    }
  }
  flush()
  return result
}

function bodyChildren(markdown: string, context: ParseContext, block: boolean): JzayNode[] {
  const tree = parseMarkdownTree(markdown)
  const nodes = block ? flowChildren(tree, context) : fromMarkdownChildren(tree, context)
  if (!block && nodes.length === 1 && nodes[0]?.type === 'paragraph') return nodes[0].children ?? []
  return nodes
}

function scan(
  source: string,
  start: number,
  end: number,
  context: ParseContext,
  expected?: ResolvedNodeConfig,
): ScanResult {
  let cursor = start
  let markdown = ''

  while (cursor < end) {
    const event = findNextEvent(source, cursor, end, context, expected)
    if (!event) {
      markdown += source.slice(cursor, end)
      if (expected) {
        if (context.mode === 'normal') {
          raise('UNCLOSED_NODE', `节点 ${expected.name} 缺少结束标签`, locationAt(source, start))
        }
        return { markdown, cursor: end, fallback: true }
      }
      return { markdown, cursor: end }
    }

    markdown += source.slice(cursor, event.start)
    if (event.kind === 'text') {
      markdown += textToken(context, event.value ?? source.slice(event.start, event.end))
      cursor = event.end
      continue
    }
    if (event.kind === 'malformed') {
      if (context.mode === 'normal') {
        raise(event.code, `节点 ${event.definition.name} 的标签格式无效`, locationAt(source, event.start))
      }
      markdown += textToken(context, source.slice(event.start, event.end))
      cursor = event.end
      continue
    }
    if (event.kind === 'close') {
      if (!expected) {
        if (context.mode === 'normal') {
          raise('UNEXPECTED_CLOSE', `出现了多余的结束标签 ${event.definition.name}`, locationAt(source, event.start))
        }
        markdown += textToken(context, source.slice(event.start, event.end))
        cursor = event.end
        continue
      }
      if (event.definition.name !== expected.name) {
        if (context.mode === 'loose') return { markdown, cursor: event.start, fallback: true }
        raise(
          'MISMATCHED_CLOSE',
          `节点 ${expected.name} 不能由 ${event.definition.name} 结束`,
          locationAt(source, event.start),
        )
      }
      return { markdown, cursor: event.end, close: event }
    }

    const definition = event.definition
    if (event.error) {
      if (definition.body === 'none') {
        markdown += textToken(context, source.slice(event.start, event.end))
        cursor = event.end
        continue
      }
      const ownClose = definition.syntax.close
        ? findLiteral(source, event.end, end, definition.syntax.close, context, false)
        : -1
      const parentClose = expected?.syntax.close
        ? findLiteral(source, event.end, end, expected.syntax.close, context, false)
        : -1
      let recoveryEnd = end
      if (ownClose !== -1 && (parentClose === -1 || ownClose < parentClose)) {
        recoveryEnd = ownClose + (definition.syntax.close?.length ?? 0)
      } else if (parentClose !== -1) recoveryEnd = parentClose
      markdown += textToken(context, source.slice(event.start, recoveryEnd))
      cursor = recoveryEnd
      continue
    }

    if (definition.body === 'none') {
      const block = isStandalone(source, event.start, event.end)
      const node: JzayNode = event.props ? { type: definition.name, props: event.props } : { type: definition.name }
      markdown += newToken(context, { node, block })
      cursor = event.end
      continue
    }

    if (definition.body === 'raw') {
      const close = definition.syntax.close ?? ''
      const closeAt = findLiteral(source, event.end, end, close, context, false)
      if (closeAt === -1) {
        if (context.mode === 'normal') {
          raise('UNCLOSED_NODE', `节点 ${definition.name} 缺少结束标签`, locationAt(source, event.start))
        }
        const parentClose = expected?.syntax.close
          ? findLiteral(source, event.end, end, expected.syntax.close, context, false)
          : -1
        const recoveryEnd = parentClose === -1 ? end : parentClose
        markdown += textToken(context, source.slice(event.start, recoveryEnd))
        cursor = recoveryEnd
        continue
      }
      const closeEnd = closeAt + close.length
      const block = isStandalone(source, event.start, closeEnd)
      const node: JzayNode = {
        type: definition.name,
        ...(event.props ? { props: event.props } : {}),
        value: decodeRawValue(source.slice(event.end, closeAt), close),
      }
      markdown += newToken(context, { node, block })
      cursor = closeEnd
      continue
    }

    const nested = scan(source, event.end, end, context, definition)
    if (nested.fallback) {
      markdown += textToken(context, source.slice(event.start, event.end))
      markdown += nested.markdown
      cursor = nested.cursor
      continue
    }
    if (!nested.close) raise('UNCLOSED_NODE', `节点 ${definition.name} 缺少结束标签`, locationAt(source, event.start))
    const block = isStandalone(source, event.start, nested.close.end)
    const node: JzayNode = {
      type: definition.name,
      ...(event.props ? { props: event.props } : {}),
      children: bodyChildren(nested.markdown, context, block),
    }
    markdown += newToken(context, { node, block })
    cursor = nested.cursor
  }

  if (expected) {
    if (context.mode === 'normal') raise('UNCLOSED_NODE', `节点 ${expected.name} 缺少结束标签`, locationAt(source, start))
    return { markdown, cursor, fallback: true }
  }
  return { markdown, cursor }
}

function compactProps(entries: ReadonlyArray<readonly [string, JsonValue | undefined | null]>): Props | undefined {
  const result: Props = {}
  for (const [key, value] of entries) if (value !== undefined && value !== null) result[key] = value
  return Object.keys(result).length === 0 ? undefined : result
}

function stringField(node: MarkdownNode, key: string): string | undefined {
  return typeof node[key] === 'string' ? node[key] : undefined
}

function booleanField(node: MarkdownNode, key: string): boolean | undefined {
  return typeof node[key] === 'boolean' ? node[key] : undefined
}

function numberField(node: MarkdownNode, key: string): number | undefined {
  return typeof node[key] === 'number' ? node[key] : undefined
}

function tokenizedText(value: string, context: ParseContext): JzayNode[] {
  const tokens = [...context.tokens.keys()].sort((left, right) => right.length - left.length)
  if (tokens.length === 0) return [{ type: 'text', value }]
  const pattern = new RegExp(tokens.join('|'), 'g')
  const result: JzayNode[] = []
  let cursor = 0
  for (const match of value.matchAll(pattern)) {
    const index = match.index
    if (index > cursor) result.push({ type: 'text', value: value.slice(cursor, index) })
    const record = context.tokens.get(match[0])
    if (record) result.push(record.node)
    cursor = index + match[0].length
  }
  if (cursor < value.length) result.push({ type: 'text', value: value.slice(cursor) })
  return result
}

function fromMarkdownChildren(node: MarkdownNode, context: ParseContext): JzayNode[] {
  const children = (node.children ?? []).flatMap((child) => fromMarkdownNode(child, context))
  const result: JzayNode[] = []
  for (const child of children) {
    const previous = result[result.length - 1]
    if (
      previous?.type === 'text'
      && child.type === 'text'
      && typeof previous.value === 'string'
      && typeof child.value === 'string'
    ) {
      previous.value += child.value
    } else result.push(child)
  }
  return result
}

function parentNode(type: string, node: MarkdownNode, context: ParseContext, props?: Props): JzayNode {
  const result: JzayNode = { type, children: fromMarkdownChildren(node, context) }
  if (props) result.props = props
  return result
}

function fromMarkdownNode(node: MarkdownNode, context: ParseContext): JzayNode[] {
  switch (node.type) {
    case 'root':
      return fromMarkdownChildren(node, context)
    case 'text':
      return tokenizedText(node.value ?? '', context)
    case 'paragraph': {
      const paragraph = parentNode('paragraph', node, context)
      const only = paragraph.children?.[0]
      return paragraph.children?.length === 1 && only && context.blockNodes.has(only) ? [only] : [paragraph]
    }
    case 'blockquote':
    case 'emphasis':
    case 'strong':
    case 'delete':
    case 'tableRow':
    case 'tableCell':
      return [parentNode(node.type, node, context)]
    case 'heading':
      return [parentNode('heading', node, context, { depth: numberField(node, 'depth') ?? 1 })]
    case 'thematicBreak':
    case 'break':
      return [{ type: node.type }]
    case 'code': {
      const props = compactProps([['lang', stringField(node, 'lang')], ['meta', stringField(node, 'meta')]])
      return [{ type: 'code', ...(props ? { props } : {}), value: node.value ?? '' }]
    }
    case 'inlineCode':
      return [{ type: node.type, value: (node.value ?? '').replace(/\r\n?|\n/gu, ' ') }]
    case 'html':
      return [{ type: 'text', value: node.value ?? '' }]
    case 'link':
      return [parentNode('link', node, context, compactProps([
        ['url', stringField(node, 'url') ?? ''], ['title', stringField(node, 'title')],
      ]))]
    case 'image':
      return [{ type: 'image', props: compactProps([
        ['url', stringField(node, 'url') ?? ''], ['alt', stringField(node, 'alt')],
        ['title', stringField(node, 'title')],
      ]) ?? {} }]
    case 'list':
      return [parentNode('list', node, context, compactProps([
        ['ordered', booleanField(node, 'ordered') ?? false], ['start', numberField(node, 'start')],
        ['spread', booleanField(node, 'spread')],
      ]))]
    case 'listItem':
      return [parentNode('listItem', node, context, compactProps([
        ['checked', booleanField(node, 'checked')], ['spread', booleanField(node, 'spread')],
      ]))]
    case 'definition':
      return [{ type: 'definition', props: compactProps([
        ['identifier', stringField(node, 'identifier') ?? ''], ['label', stringField(node, 'label')],
        ['url', stringField(node, 'url') ?? ''], ['title', stringField(node, 'title')],
      ]) ?? {} }]
    case 'linkReference':
      return [parentNode('linkReference', node, context, compactProps([
        ['identifier', stringField(node, 'identifier') ?? ''], ['label', stringField(node, 'label')],
        ['referenceType', stringField(node, 'referenceType') ?? 'shortcut'],
      ]))]
    case 'imageReference':
      return [{ type: 'imageReference', props: compactProps([
        ['identifier', stringField(node, 'identifier') ?? ''], ['label', stringField(node, 'label')],
        ['referenceType', stringField(node, 'referenceType') ?? 'shortcut'], ['alt', stringField(node, 'alt')],
      ]) ?? {} }]
    case 'footnoteDefinition':
      return [parentNode('footnoteDefinition', node, context, compactProps([
        ['identifier', stringField(node, 'identifier') ?? ''], ['label', stringField(node, 'label')],
      ]))]
    case 'footnoteReference':
      return [{ type: 'footnoteReference', props: compactProps([
        ['identifier', stringField(node, 'identifier') ?? ''], ['label', stringField(node, 'label')],
      ]) ?? {} }]
    case 'table': {
      const align = Array.isArray(node.align)
        ? node.align.map((value) => value === null || typeof value === 'string' ? value : null)
        : []
      return [parentNode('table', node, context, { align })]
    }
    default:
      raise('UNSUPPORTED_MARKDOWN', `Markdown 节点 ${node.type} 暂不支持`)
  }
}

function uniquePrefix(source: string): string {
  let prefix = 'JZAYMARKTOKENQZQ'
  while (source.includes(prefix)) prefix += 'Q'
  return prefix
}

export function parseMarkdown(
  source: string,
  config: Readonly<ResolvedJzayMarkConfig>,
  options: ParseOptions = {},
): JzayAst {
  if (typeof source !== 'string') raise('INVALID_SOURCE', 'parse() 只接受字符串')
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    raise('INVALID_OPTIONS', 'parse() 的 options 必须是对象')
  }
  const unknownOption = Object.keys(options).find((key) => !['version', 'mode'].includes(key))
  if (unknownOption) raise('INVALID_OPTIONS', `parse() 不支持选项 ${unknownOption}`)
  if (options.version !== undefined && options.version !== AST_VERSION) {
    raise('UNSUPPORTED_VERSION', `不支持 AST 版本 ${String(options.version)}`)
  }
  if (options.mode !== undefined && options.mode !== 'normal' && options.mode !== 'loose') {
    raise('INVALID_OPTIONS', `不支持解析模式 ${String(options.mode)}`)
  }

  const initialTree = parseMarkdownTree(source)
  const context: ParseContext = {
    config,
    mode: options.mode ?? 'normal',
    prefix: uniquePrefix(source),
    nextToken: 0,
    protectedRanges: codeRanges(initialTree),
    tokens: new Map(),
    blockNodes: new WeakSet(),
  }
  const scanned = scan(source, 0, source.length, context)
  return createAst(flowChildren(parseMarkdownTree(scanned.markdown), context))
}

interface PrintContext {
  config: Readonly<ResolvedJzayMarkConfig>
  processor: MarkdownProcessor
  prefix: string
  nextToken: number
  replacements: Map<string, string>
}

function valueString(value: JsonValue | undefined, path: string, fallback = ''): string {
  if (value === undefined) return fallback
  if (typeof value !== 'string') raise('INVALID_AST', `${path} 必须是字符串`)
  return value
}

function propString(props: Props, key: string, fallback = ''): string {
  return valueString(props[key], `props.${key}`, fallback)
}

function propBoolean(props: Props, key: string, fallback?: boolean): boolean | undefined {
  const value = props[key]
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') raise('INVALID_AST', `props.${key} 必须是布尔值`)
  return value
}

function propNumber(props: Props, key: string, fallback?: number): number | undefined {
  const value = props[key]
  if (value === undefined) return fallback
  if (typeof value !== 'number') raise('INVALID_AST', `props.${key} 必须是数字`)
  return value
}

function setDefined(target: MarkdownNode, key: string, value: unknown): void {
  if (value !== undefined && value !== null && value !== '') target[key] = value
}

function escapeAttribute(value: string, quote: string): string {
  let result = ''
  for (const character of value) {
    if (character === '\\') result += '\\\\'
    else if (character === quote) result += `\\${character}`
    else if (character === '\n') result += '\\n'
    else if (character === '\r') result += '\\r'
    else if (character === '\t') result += '\\t'
    else result += character
  }
  return result
}

function printAttributes(
  props: Props | undefined,
  nodeType: string,
  format: ResolvedPropsConfig,
): string {
  if (!props) return ''
  return Object.keys(props).sort().map((key) => {
    const value = props[key]
    if (!validAttributeKey(key, format)) {
      raise('UNPRINTABLE_PROP', `自定义节点 ${nodeType} 的属性名 ${JSON.stringify(key)} 无法输出`)
    }
    if (value === true) return key
    if (typeof value !== 'string') {
      raise('UNPRINTABLE_PROP', `自定义节点 ${nodeType} 的属性 ${key} 只能是字符串或 true`)
    }
    return `${key}${format.assign}${format.quote}${escapeAttribute(value, format.quote)}${format.quote}`
  }).join(format.separator)
}

function replaceTokens(markdown: string, context: PrintContext): string {
  let result = markdown
  for (const [token, value] of context.replacements) {
    result = result.split(token).join(value)
    const first = token.codePointAt(0)
    if (first !== undefined) {
      const encoded = `&#x${first.toString(16).toUpperCase()};${token.slice(String.fromCodePoint(first).length)}`
      result = result.split(encoded).join(value)
    }
  }
  return result
}

function printToken(context: PrintContext, value: string): string {
  const token = `${context.prefix}${context.nextToken}Z`
  context.nextToken += 1
  context.replacements.set(token, value)
  return token
}

function protectLiteralText(value: string, context: PrintContext): string {
  const scanner: ParseContext = {
    config: context.config,
    mode: 'loose',
    prefix: '',
    nextToken: 0,
    protectedRanges: [],
    tokens: new Map(),
    blockNodes: new WeakSet(),
  }
  let result = ''
  let emittedUntil = 0
  let cursor = 0
  while (cursor < value.length) {
    const event = eventAt(value, cursor, value.length, scanner)
    if (!event) {
      const codePoint = value.codePointAt(cursor)
      const width = codePoint !== undefined && codePoint > 0xffff ? 2 : 1
      if (width === 2) {
        result += value.slice(emittedUntil, cursor)
        result += printToken(context, value.slice(cursor, cursor + width))
        emittedUntil = cursor + width
      }
      cursor += width
      continue
    }
    let slashStart = cursor
    while (slashStart > emittedUntil && value[slashStart - 1] === '\\') slashStart -= 1
    const slashCount = cursor - slashStart
    result += value.slice(emittedUntil, slashStart)
    result += printToken(
      context,
      `${'\\'.repeat(slashCount * 2 + (event.kind === 'text' ? 0 : 1))}${value.slice(cursor, event.end)}`,
    )
    emittedUntil = event.end
    cursor = event.end
  }
  return `${result}${value.slice(emittedUntil)}`
}

function makePrintContext(
  nodes: JzayNode[],
  config: Readonly<ResolvedJzayMarkConfig>,
  markdownProcessor: MarkdownProcessor,
): PrintContext {
  const serialized = JSON.stringify(nodes)
  let prefix = 'JZAYMARKPRINTTOKENQZQ'
  while (serialized.includes(prefix) || serialized.includes(`&#x4A;${prefix.slice(1)}`)) prefix += 'Q'
  return { config, processor: markdownProcessor, prefix, nextToken: 0, replacements: new Map() }
}

function stringifyNodes(
  nodes: JzayNode[],
  config: Readonly<ResolvedJzayMarkConfig>,
  inline: boolean,
  markdownProcessor: MarkdownProcessor,
): string {
  const context = makePrintContext(nodes, config, markdownProcessor)
  const root: MarkdownNode = inline
    ? { type: 'root', children: [{ type: 'paragraph', children: nodes.map((node) => toMarkdownNode(node, 'paragraph', context)) }] }
    : { type: 'root', children: nodes.map((node) => toMarkdownNode(node, 'root', context)) }
  const output = markdownProcessor.stringify(root as unknown as Root)
  return replaceTokens(output, context).replace(/\n$/u, '')
}

function customSyntax(node: JzayNode, context: PrintContext, inlinePlacement: boolean): string {
  const definition = context.config.nodes[node.type]
  if (!definition) raise('UNKNOWN_NODE', `节点 ${node.type} 尚未配置`)
  const attributes = printAttributes(node.props, node.type, definition.props)
  if (attributes && !definition.syntax.open.includes('{props}')) {
    raise('UNPRINTABLE_PROP', `节点 ${node.type} 的 syntax.open 没有 {props}，无法输出属性`)
  }
  const opening = renderOpeningTemplate(definition.syntax.open, attributes)
  if (definition.body === 'none') {
    if (node.value !== undefined || (node.children?.length ?? 0) > 0) {
      raise('INVALID_AST', `body 为 none 的节点 ${node.type} 不能包含 value 或 children`)
    }
    return opening
  }

  const closing = definition.syntax.close ?? ''
  if (definition.body === 'raw') {
    if ((node.children?.length ?? 0) > 0) raise('INVALID_AST', `body 为 raw 的节点 ${node.type} 不能包含 children`)
    return `${opening}${encodeRawValue(valueString(node.value, `${node.type}.value`), closing)}${closing}`
  }

  if (node.value !== undefined) raise('INVALID_AST', `body 为 parse 的节点 ${node.type} 不能包含 value`)
  const children = node.children ?? []
  const inline = inlinePlacement && children.every((child) => (
    PHRASING_NODES.has(child.type) || context.config.nodes[child.type] !== undefined
  ))
  const body = stringifyNodes(children, context.config, inline, context.processor)
  if (!body) return `${opening}${closing}`
  return inline ? `${opening}${body}${closing}` : `${opening}\n${body}\n${closing}`
}

function customToken(node: JzayNode, context: PrintContext, inlinePlacement: boolean): string {
  return printToken(context, customSyntax(node, context, inlinePlacement))
}

function markdownParent(type: string, node: JzayNode, context: PrintContext): MarkdownNode {
  return { type, children: (node.children ?? []).map((child) => toMarkdownNode(child, type, context)) }
}

function customMarkdownNode(node: JzayNode, parentType: string, context: PrintContext): MarkdownNode {
  const inline = PHRASING_PARENTS.has(parentType)
  const text: MarkdownNode = { type: 'text', value: customToken(node, context, inline) }
  return inline ? text : { type: 'paragraph', children: [text] }
}

function toMarkdownNode(node: JzayNode, parentType: string, context: PrintContext): MarkdownNode {
  const props = node.props ?? {}
  if (!BUILTIN_NODE_TYPES.has(node.type)) return customMarkdownNode(node, parentType, context)

  switch (node.type) {
    case 'document':
      return markdownParent('root', node, context)
    case 'text':
      return { type: 'text', value: protectLiteralText(valueString(node.value, 'text.value'), context) }
    case 'inlineCode':
      return { type: 'inlineCode', value: valueString(node.value, 'inlineCode.value') }
    case 'code': {
      const result: MarkdownNode = { type: 'code', value: valueString(node.value, 'code.value') }
      setDefined(result, 'lang', propString(props, 'lang'))
      setDefined(result, 'meta', propString(props, 'meta'))
      return result
    }
    case 'paragraph':
    case 'blockquote':
    case 'emphasis':
    case 'strong':
    case 'delete':
    case 'tableRow':
    case 'tableCell':
      return markdownParent(node.type, node, context)
    case 'heading': {
      const result = markdownParent('heading', node, context)
      result.depth = propNumber(props, 'depth', 1)
      return result
    }
    case 'thematicBreak':
    case 'break':
      return { type: node.type }
    case 'link': {
      const result = markdownParent('link', node, context)
      result.url = propString(props, 'url')
      setDefined(result, 'title', props.title === undefined ? undefined : propString(props, 'title'))
      return result
    }
    case 'image': {
      const result: MarkdownNode = { type: 'image', url: propString(props, 'url') }
      setDefined(result, 'alt', props.alt === undefined ? undefined : propString(props, 'alt'))
      setDefined(result, 'title', props.title === undefined ? undefined : propString(props, 'title'))
      return result
    }
    case 'list': {
      const result = markdownParent('list', node, context)
      result.ordered = propBoolean(props, 'ordered', false)
      setDefined(result, 'start', propNumber(props, 'start'))
      setDefined(result, 'spread', propBoolean(props, 'spread'))
      return result
    }
    case 'listItem': {
      const result = markdownParent('listItem', node, context)
      setDefined(result, 'checked', propBoolean(props, 'checked'))
      setDefined(result, 'spread', propBoolean(props, 'spread'))
      return result
    }
    case 'definition': {
      const result: MarkdownNode = {
        type: 'definition',
        identifier: propString(props, 'identifier'),
        url: propString(props, 'url'),
      }
      setDefined(result, 'label', props.label === undefined ? undefined : propString(props, 'label'))
      setDefined(result, 'title', props.title === undefined ? undefined : propString(props, 'title'))
      return result
    }
    case 'linkReference': {
      const result = markdownParent('linkReference', node, context)
      result.identifier = propString(props, 'identifier')
      result.referenceType = propString(props, 'referenceType', 'shortcut')
      setDefined(result, 'label', props.label === undefined ? undefined : propString(props, 'label'))
      return result
    }
    case 'imageReference': {
      const result: MarkdownNode = {
        type: 'imageReference',
        identifier: propString(props, 'identifier'),
        referenceType: propString(props, 'referenceType', 'shortcut'),
      }
      setDefined(result, 'label', props.label === undefined ? undefined : propString(props, 'label'))
      setDefined(result, 'alt', props.alt === undefined ? undefined : propString(props, 'alt'))
      return result
    }
    case 'footnoteDefinition': {
      const result = markdownParent('footnoteDefinition', node, context)
      result.identifier = propString(props, 'identifier')
      setDefined(result, 'label', props.label === undefined ? undefined : propString(props, 'label'))
      return result
    }
    case 'footnoteReference': {
      const result: MarkdownNode = { type: 'footnoteReference', identifier: propString(props, 'identifier') }
      setDefined(result, 'label', props.label === undefined ? undefined : propString(props, 'label'))
      return result
    }
    case 'table': {
      const result = markdownParent('table', node, context)
      result.align = Array.isArray(props.align) ? props.align : []
      return result
    }
  }
  raise('INVALID_AST', `标准节点 ${node.type} 无法打印`)
}

function rejectNodeField(node: Partial<JzayNode>, field: 'props' | 'value' | 'children', path: string): void {
  if (node[field] !== undefined) raise('INVALID_AST', `${path}.${field} 不适用于节点 ${String(node.type)}`)
}

function checkedProps(
  node: Partial<JzayNode>,
  path: string,
  allowed: readonly string[],
  required: readonly string[] = [],
): Props {
  const props = node.props ?? {}
  const unknown = Object.keys(props).find((key) => !allowed.includes(key))
  if (unknown) raise('INVALID_AST', `${path}.props.${unknown} 不适用于节点 ${String(node.type)}`)
  const missing = required.find((key) => !Object.prototype.hasOwnProperty.call(props, key))
  if (missing) raise('INVALID_AST', `${path}.props.${missing} 是必填字段`)
  return props
}

function assertStringProp(
  props: Props,
  key: string,
  path: string,
  required = false,
  nonEmpty = false,
): void {
  const value = props[key]
  if (value === undefined && !required) return
  if (typeof value !== 'string') raise('INVALID_AST', `${path}.props.${key} 必须是字符串`)
  if (value.includes('\0')) raise('INVALID_AST', `${path}.props.${key} 不能包含 NUL 字符`)
  if (nonEmpty && value.length === 0) raise('INVALID_AST', `${path}.props.${key} 不能为空字符串`)
}

function assertBooleanProp(props: Props, key: string, path: string, required = false): void {
  const value = props[key]
  if (value === undefined && !required) return
  if (typeof value !== 'boolean') raise('INVALID_AST', `${path}.props.${key} 必须是布尔值`)
}

function requireChildren(
  node: Partial<JzayNode>,
  path: string,
): asserts node is Partial<JzayNode> & { children: JzayNode[] } {
  if (!Array.isArray(node.children)) raise('INVALID_AST', `${path}.children 是必填数组`)
}

function requireNonEmptyChildren(
  node: Partial<JzayNode>,
  path: string,
): asserts node is Partial<JzayNode> & { children: JzayNode[] } {
  requireChildren(node, path)
  if (node.children.length === 0) raise('INVALID_AST', `${path}.children 不能为空`)
}

function assertChildTypes(
  node: Partial<JzayNode>,
  path: string,
  allowed: ReadonlySet<string>,
  label: string,
  allowCustom = true,
): void {
  for (const [index, child] of (node.children ?? []).entries()) {
    if (!allowed.has(child.type) && (BUILTIN_NODE_TYPES.has(child.type) || !allowCustom)) {
      raise('INVALID_AST', `${path}.children[${index}] 的 ${child.type} 不是${label}节点`)
    }
  }
}

function assertStandardNode(node: Partial<JzayNode>, path: string): void {
  const rejectProps = () => rejectNodeField(node, 'props', path)
  const rejectValue = () => rejectNodeField(node, 'value', path)
  const rejectChildren = () => rejectNodeField(node, 'children', path)

  switch (node.type) {
    case 'document':
      raise('INVALID_AST', `${path} 不能嵌套 document 节点`)
    case 'text':
    case 'inlineCode':
      rejectProps()
      rejectChildren()
      if (typeof node.value !== 'string') raise('INVALID_AST', `${path}.value 必须是字符串`)
      if (node.type === 'text' && node.value.length === 0) raise('INVALID_AST', `${path}.value 不能为空`)
      if (node.value.includes('\0')) raise('INVALID_AST', `${path}.value 不能包含 NUL 字符`)
      if (node.type === 'inlineCode' && /[\r\n]/u.test(node.value)) {
        raise('INVALID_AST', `${path}.value 不能包含换行`)
      }
      return
    case 'code': {
      rejectChildren()
      if (typeof node.value !== 'string') raise('INVALID_AST', `${path}.value 必须是字符串`)
      if (node.value.includes('\0')) raise('INVALID_AST', `${path}.value 不能包含 NUL 字符`)
      const props = checkedProps(node, path, ['lang', 'meta'])
      assertStringProp(props, 'lang', path, false, true)
      assertStringProp(props, 'meta', path, false, true)
      if (props.meta !== undefined && props.lang === undefined) {
        raise('INVALID_AST', `${path}.props.meta 必须与 lang 一起使用`)
      }
      return
    }
    case 'paragraph':
      rejectProps()
      rejectValue()
      requireNonEmptyChildren(node, path)
      assertChildTypes(node, path, PHRASING_NODES, '行内')
      if (node.children.length === 1 && !BUILTIN_NODE_TYPES.has(node.children[0]?.type ?? '')) {
        raise('INVALID_AST', `${path} 不能只包含一个自定义节点；该节点应放在当前块级位置`)
      }
      return
    case 'emphasis':
    case 'strong':
    case 'delete':
      rejectProps()
      rejectValue()
      requireNonEmptyChildren(node, path)
      assertChildTypes(node, path, PHRASING_NODES, '行内')
      return
    case 'tableCell':
      rejectProps()
      rejectValue()
      requireChildren(node, path)
      assertChildTypes(node, path, PHRASING_NODES, '行内')
      return
    case 'blockquote':
      rejectProps()
      rejectValue()
      requireChildren(node, path)
      assertChildTypes(node, path, FLOW_NODES, '块级')
      return
    case 'tableRow':
      rejectProps()
      rejectValue()
      requireChildren(node, path)
      assertChildTypes(node, path, TABLE_CELL_NODES, '表格单元格')
      return
    case 'heading': {
      rejectValue()
      const props = checkedProps(node, path, ['depth'], ['depth'])
      const depth = props.depth
      if (!Number.isInteger(depth) || typeof depth !== 'number' || depth < 1 || depth > 6) {
        raise('INVALID_AST', `${path}.props.depth 必须是 1 到 6 的整数`)
      }
      requireChildren(node, path)
      assertChildTypes(node, path, PHRASING_NODES, '行内')
      return
    }
    case 'thematicBreak':
    case 'break':
      rejectProps()
      rejectValue()
      rejectChildren()
      return
    case 'link': {
      rejectValue()
      const props = checkedProps(node, path, ['url', 'title'], ['url'])
      assertStringProp(props, 'url', path, true)
      assertStringProp(props, 'title', path, false, true)
      requireChildren(node, path)
      assertChildTypes(node, path, PHRASING_NODES, '行内')
      return
    }
    case 'image': {
      rejectValue()
      rejectChildren()
      const props = checkedProps(node, path, ['url', 'alt', 'title'], ['url', 'alt'])
      assertStringProp(props, 'url', path, true)
      assertStringProp(props, 'alt', path, true)
      assertStringProp(props, 'title', path, false, true)
      return
    }
    case 'list': {
      rejectValue()
      const props = checkedProps(node, path, ['ordered', 'start', 'spread'], ['ordered'])
      assertBooleanProp(props, 'ordered', path, true)
      assertBooleanProp(props, 'spread', path, true)
      if (props.start !== undefined && (!Number.isInteger(props.start) || typeof props.start !== 'number' || props.start < 0)) {
        raise('INVALID_AST', `${path}.props.start 必须是非负整数`)
      }
      if (props.ordered === false && props.start !== undefined) {
        raise('INVALID_AST', `${path}.props.start 只适用于有序列表`)
      }
      if (props.ordered === true && props.start === undefined) {
        raise('INVALID_AST', `${path}.props.start 是有序列表的必填字段`)
      }
      requireChildren(node, path)
      assertChildTypes(node, path, LIST_ITEM_NODES, '列表项', false)
      return
    }
    case 'listItem': {
      rejectValue()
      const props = checkedProps(node, path, ['checked', 'spread'], ['spread'])
      assertBooleanProp(props, 'checked', path)
      assertBooleanProp(props, 'spread', path, true)
      requireChildren(node, path)
      assertChildTypes(node, path, FLOW_NODES, '块级')
      return
    }
    case 'definition': {
      rejectValue()
      rejectChildren()
      const props = checkedProps(node, path, ['identifier', 'label', 'url', 'title'], ['identifier', 'url'])
      assertStringProp(props, 'identifier', path, true, true)
      assertStringProp(props, 'label', path, false, true)
      assertStringProp(props, 'url', path, true)
      assertStringProp(props, 'title', path, false, true)
      return
    }
    case 'linkReference': {
      rejectValue()
      const props = checkedProps(node, path, ['identifier', 'label', 'referenceType'], ['identifier', 'referenceType'])
      assertStringProp(props, 'identifier', path, true, true)
      assertStringProp(props, 'label', path, false, true)
      if (!['shortcut', 'collapsed', 'full'].includes(String(props.referenceType))) {
        raise('INVALID_AST', `${path}.props.referenceType 无效`)
      }
      requireChildren(node, path)
      assertChildTypes(node, path, PHRASING_NODES, '行内')
      return
    }
    case 'imageReference': {
      rejectValue()
      rejectChildren()
      const props = checkedProps(
        node,
        path,
        ['identifier', 'label', 'referenceType', 'alt'],
        ['identifier', 'referenceType', 'alt'],
      )
      assertStringProp(props, 'identifier', path, true, true)
      assertStringProp(props, 'label', path, false, true)
      assertStringProp(props, 'alt', path, true)
      if (!['shortcut', 'collapsed', 'full'].includes(String(props.referenceType))) {
        raise('INVALID_AST', `${path}.props.referenceType 无效`)
      }
      return
    }
    case 'footnoteDefinition': {
      rejectValue()
      const props = checkedProps(node, path, ['identifier', 'label'], ['identifier'])
      assertStringProp(props, 'identifier', path, true, true)
      assertStringProp(props, 'label', path, false, true)
      requireChildren(node, path)
      assertChildTypes(node, path, FLOW_NODES, '块级')
      return
    }
    case 'footnoteReference': {
      rejectValue()
      rejectChildren()
      const props = checkedProps(node, path, ['identifier', 'label'], ['identifier'])
      assertStringProp(props, 'identifier', path, true, true)
      assertStringProp(props, 'label', path, false, true)
      return
    }
    case 'table': {
      rejectValue()
      const props = checkedProps(node, path, ['align'], ['align'])
      if (!Array.isArray(props.align) || props.align.some((value) => (
        value !== null && value !== 'left' && value !== 'right' && value !== 'center'
      ))) {
        raise('INVALID_AST', `${path}.props.align 必须是由 null、left、right 或 center 组成的数组`)
      }
      requireChildren(node, path)
      if (node.children.length === 0) raise('INVALID_AST', `${path}.children 不能为空`)
      assertChildTypes(node, path, TABLE_ROW_NODES, '表格行', false)
      const widths = node.children.map((row) => row.children?.length ?? 0)
      const width = widths[0] ?? 0
      if (width === 0 || widths.some((value) => value !== width)) {
        raise('INVALID_AST', `${path} 的每一行必须包含相同数量的单元格`)
      }
      if (props.align.length !== width) {
        raise('INVALID_AST', `${path}.props.align 数量必须与每行单元格数量一致`)
      }
      return
    }
  }
  raise('INVALID_AST', `标准节点 ${String(node.type)} 无法打印`)
}

function assertCustomNode(
  node: Partial<JzayNode>,
  path: string,
  config: Readonly<ResolvedJzayMarkConfig>,
  placement: NodePlacement,
): void {
  const definition = node.type ? config.nodes[node.type] : undefined
  if (!definition) raise('UNKNOWN_NODE', `节点 ${String(node.type)} 尚未配置`)
  if (definition.body === 'none') {
    rejectNodeField(node, 'value', path)
    rejectNodeField(node, 'children', path)
  } else if (definition.body === 'raw') {
    rejectNodeField(node, 'children', path)
    if (typeof node.value !== 'string') {
      raise('INVALID_AST', `${path}.value 必须是字符串`)
    }
  } else {
    rejectNodeField(node, 'value', path)
    requireChildren(node, path)
    assertChildTypes(
      node,
      path,
      placement === 'phrasing' ? PHRASING_NODES : FLOW_NODES,
      placement === 'phrasing' ? '行内' : '块级',
    )
  }
  if (node.props) {
    for (const [key, value] of Object.entries(node.props)) {
      if (value !== true && typeof value !== 'string') {
        raise('UNPRINTABLE_PROP', `${path}.props.${key} 只能是字符串或 true`)
      }
    }
  }
}

function assertReferences(root: JzayAst): void {
  const definitions = new Set<string>()
  const footnotes = new Set<string>()
  const references: Array<{ identifier: string, footnote: boolean, path: string }> = []
  const visit = (nodes: JzayNode[], path: string): void => {
    nodes.forEach((node, index) => {
      const nodePath = `${path}[${index}]`
      const identifier = typeof node.props?.identifier === 'string' ? node.props.identifier : undefined
      if (node.type === 'definition' && identifier !== undefined) definitions.add(identifier)
      else if (node.type === 'footnoteDefinition' && identifier !== undefined) footnotes.add(identifier)
      else if ((node.type === 'linkReference' || node.type === 'imageReference') && identifier !== undefined) {
        references.push({ identifier, footnote: false, path: nodePath })
      } else if (node.type === 'footnoteReference' && identifier !== undefined) {
        references.push({ identifier, footnote: true, path: nodePath })
      }
      if (node.children) visit(node.children, `${nodePath}.children`)
    })
  }
  visit(root.children, 'children')
  for (const reference of references) {
    const available = reference.footnote ? footnotes : definitions
    if (!available.has(reference.identifier)) {
      raise('INVALID_AST', `${reference.path} 缺少 identifier 为 ${reference.identifier} 的对应定义`)
    }
  }
}

function assertAst(input: unknown, config: Readonly<ResolvedJzayMarkConfig>): asserts input is JzayAst {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    raise('INVALID_AST', 'print() 需要一个 AST 对象')
  }
  const root = input as Partial<JzayAst>
  if (root.version !== AST_VERSION) raise('UNSUPPORTED_VERSION', `不支持 AST 版本 ${String(root.version)}`)
  if (root.type !== 'document' || !Array.isArray(root.children)) {
    raise('INVALID_AST', 'AST 根节点必须是包含 children 的 document')
  }
  const rootKeys = Object.keys(root)
  if (rootKeys.some((key) => !['version', 'type', 'children'].includes(key))) {
    raise('INVALID_AST', 'AST 根节点只能包含 version、type 和 children')
  }
  const ancestors = new WeakSet<object>()
  root.children.forEach((node, index) => assertNode(node, `children[${index}]`, ancestors, config, 'flow'))
  assertChildTypes(root, 'AST', FLOW_NODES, '块级')
  assertReferences(root as JzayAst)
}

function assertJson(value: unknown, path: string, ancestors: WeakSet<object>): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) raise('INVALID_AST', `${path} 必须是有限数字`)
    return
  }
  if (typeof value !== 'object') raise('INVALID_AST', `${path} 必须是 JSON 值`)
  if (ancestors.has(value)) raise('INVALID_AST', `${path} 不能包含循环引用`)
  ancestors.add(value)
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertJson(child, `${path}[${index}]`, ancestors))
  } else {
    for (const [key, child] of Object.entries(value)) assertJson(child, `${path}.${key}`, ancestors)
  }
  ancestors.delete(value)
}

function assertNode(
  input: unknown,
  path: string,
  ancestors: WeakSet<object>,
  config: Readonly<ResolvedJzayMarkConfig>,
  placement: NodePlacement,
): asserts input is JzayNode {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    raise('INVALID_AST', `${path} 必须是节点对象`)
  }
  if (ancestors.has(input)) raise('INVALID_AST', `${path} 不能包含循环引用`)
  ancestors.add(input)
  const node = input as Partial<JzayNode>
  if (typeof node.type !== 'string' || node.type.length === 0) raise('INVALID_AST', `${path}.type 必须是非空字符串`)
  if (Object.keys(node).some((key) => !['type', 'props', 'value', 'children'].includes(key))) {
    raise('INVALID_AST', `${path} 包含未知字段`)
  }
  if (node.props !== undefined) {
    if (node.props === null || typeof node.props !== 'object' || Array.isArray(node.props)) {
      raise('INVALID_AST', `${path}.props 必须是对象`)
    }
    if (Object.keys(node.props).length === 0) raise('INVALID_AST', `${path}.props 不能为空对象`)
    assertJson(node.props, `${path}.props`, ancestors)
  }
  if (node.value !== undefined) assertJson(node.value, `${path}.value`, ancestors)
  if (node.children !== undefined) {
    if (!Array.isArray(node.children)) raise('INVALID_AST', `${path}.children 必须是数组`)
    const childPlacement: NodePlacement = BUILTIN_NODE_TYPES.has(node.type)
      ? (PHRASING_PARENTS.has(node.type) ? 'phrasing' : 'flow')
      : placement
    node.children.forEach((child, index) => (
      assertNode(child, `${path}.children[${index}]`, ancestors, config, childPlacement)
    ))
    for (let index = 1; index < node.children.length; index += 1) {
      if (node.children[index - 1]?.type === 'text' && node.children[index]?.type === 'text') {
        raise('INVALID_AST', `${path}.children 不能包含相邻的 text 节点`)
      }
    }
  }
  if (BUILTIN_NODE_TYPES.has(node.type)) assertStandardNode(node, path)
  else assertCustomNode(node, path, config, placement)
  ancestors.delete(input)
}

function structurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => structurallyEqual(value, right[index]))
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord).sort()
  const rightKeys = Object.keys(rightRecord).sort()
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && structurallyEqual(leftRecord[key], rightRecord[key]))
}

export function printMarkdown(ast: JzayAst, config: Readonly<ResolvedJzayMarkConfig>): string {
  assertAst(ast, config)
  for (let profile = 0; profile < markdownProfiles.length; profile += 1) {
    const markdownProcessor = markdownProcessorAt(profile)
    let output: string
    try {
      const markdown = stringifyNodes(ast.children, config, false, markdownProcessor)
      output = markdown ? `${markdown}\n` : ''
    } catch (error) {
      if (error instanceof JzayMarkError) throw error
      raise('INVALID_AST', `AST 无法输出：${error instanceof Error ? error.message : String(error)}`)
    }
    try {
      if (structurallyEqual(parseMarkdown(output, config), ast)) return output
    } catch (error) {
      if (!(error instanceof JzayMarkError)) throw error
    }
  }
  raise('INVALID_AST', 'AST 在当前配置下无法无损输出')
}
