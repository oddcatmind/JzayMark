import fc from 'fast-check'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  AST_VERSION,
  JzayMarkError,
  configure,
  parse,
  print,
} from '../src/index.js'
import type { JzayAst } from '../src/index.js'

if (false) {
  const root: JzayAst = {
    version: 'v1',
    type: 'document',
    children: [],
    // @ts-expect-error document 根节点不能带普通节点字段
    props: {},
  }
  void root
}

function configureLanguage() {
  return configure({
    defaults: {
      props: { separator: ' ', assign: '=', quote: '"' },
    },
    nodes: {
      callout: { body: 'parse' },
      chart: {},
      product: { body: 'none' },
      box: {
        body: 'parse',
        syntax: { open: '[[box {props}]]', close: '[[/box]]' },
      },
      command: {
        body: 'none',
        syntax: { open: '@command({props})' },
        props: { separator: ',', assign: ':', quote: '"' },
      },
    },
  })
}

describe('configuration', () => {
  beforeEach(configureLanguage)

  it('resolves one immutable configuration table', () => {
    const configured = configureLanguage()
    expect(configured.defaults?.props).toEqual({ separator: ' ', assign: '=', quote: '"' })
    expect(configured.nodes.callout?.syntax?.open).toBe('<callout {props}>')
    expect(configured.nodes.callout?.syntax?.close).toBe('</callout>')
    expect(configured.nodes.chart?.body).toBe('raw')
    expect(Object.isFrozen(configured)).toBe(true)
    expect(Object.isFrozen(configured.nodes)).toBe(true)
    if (false) {
      // @ts-expect-error configure() returns a deeply readonly configuration
      configured.nodes.callout.body = 'raw'
    }
  })

  it('lets node props override defaults field by field', () => {
    const configured = configure({
      defaults: { props: { separator: ',', assign: '=', quote: '"' } },
      nodes: {
        item: {
          body: 'none',
          props: { assign: ':' },
        },
      },
    })
    expect(configured.nodes.item?.props).toEqual({ separator: ',', assign: ':', quote: '"' })
    expect(parse('<item id:"1",enabled>').children[0]).toEqual({
      type: 'item',
      props: { id: '1', enabled: true },
    })
  })

  it('supports a single Unicode code point as an attribute delimiter', () => {
    configure({
      defaults: { props: { quote: '😀' } },
      nodes: { item: { body: 'none' } },
    })
    const ast = parse('<item label=😀内容😀>')
    expect(ast.children[0]?.props).toEqual({ label: '内容' })
    expect(parse(print(ast))).toEqual(ast)
  })

  it('uses the later node when configured syntax conflicts', () => {
    configure({
      nodes: {
        first: { body: 'none', syntax: { open: '@same' } },
        second: { body: 'none', syntax: { open: '@same' } },
      },
    })
    expect(parse('@same').children).toEqual([{ type: 'second' }])
    expect(() => print({
      version: 'v1',
      type: 'document',
      children: [{ type: 'first' }],
    })).toThrowError(expect.objectContaining({ code: 'INVALID_AST' }))
  })

  it.each([
    { syntax: { open: '[[', close: ']]' }, nodes: {} },
    { defaults: { syntax: { open: '[[', close: ']]' } }, nodes: {} },
    { nodes: { paragraph: {} } },
    { nodes: { bad: { body: 'other' } } },
    { nodes: { bad: { body: 'parse', syntax: { open: '[[bad]]' } } } },
    { nodes: { bad: { body: 'none', syntax: { open: '@bad', close: '@/bad' } } } },
    { nodes: { bad: { syntax: { open: '{props}' } } } },
    { nodes: { bad: { syntax: { open: '@bad{props}', close: '@/bad' } } } },
    { nodes: { bad: { syntax: { open: '@@', close: '@' } } } },
    { nodes: { bad: { body: 'none', syntax: { open: '@bad\n' } } } },
    { nodes: { bad: { syntax: { open: '@bad', close: '@/bad\n' } } } },
    { defaults: { props: { separator: '=', assign: '=' } }, nodes: {} },
    { defaults: { props: { separator: '::' } }, nodes: {} },
    { defaults: { props: { assign: '::' } }, nodes: {} },
    { defaults: { props: { quote: ' ' } }, nodes: {} },
    { defaults: { props: { quote: '\\' } }, nodes: {} },
  ])('rejects invalid or legacy configuration without compatibility', (input) => {
    expect(() => configure(input as never)).toThrow(JzayMarkError)
  })
})

describe('parse', () => {
  beforeEach(configureLanguage)

  it('returns the compact v1 document AST by default or explicitly', () => {
    const expected = {
      version: 'v1',
      type: 'document',
      children: [{
        type: 'heading',
        props: { depth: 1 },
        children: [{ type: 'text', value: 'Hello' }],
      }],
    }
    expect(parse('# Hello')).toEqual(expected)
    expect(parse('# Hello', { version: 'v1' })).toEqual(expected)
    expect(AST_VERSION).toBe('v1')
  })

  it('parses the fixed system syntax recursively', () => {
    const ast = parse('<callout tone="warning" disabled>**world** <product id="42"></callout>')
    expect(ast.children).toEqual([{
      type: 'callout',
      props: { tone: 'warning', disabled: true },
      children: [{
        type: 'paragraph',
        children: [
          { type: 'strong', children: [{ type: 'text', value: 'world' }] },
          { type: 'text', value: ' ' },
          { type: 'product', props: { id: '42' } },
        ],
      }],
    }])
  })

  it('parses independent node syntax and props formats', () => {
    const ast = parse('[[box tone="info"]]Text @command(id:"100",enabled)[[/box]]')
    expect(ast.children[0]).toEqual({
      type: 'box',
      props: { tone: 'info' },
      children: [{
        type: 'paragraph',
        children: [
          { type: 'text', value: 'Text ' },
          { type: 'command', props: { id: '100', enabled: true } },
        ],
      }],
    })
  })

  it('preserves raw bodies without Markdown parsing', () => {
    const body = '\n**not Markdown**\n<callout>not nested</callout>\n'
    expect(parse(`<chart type="bar">${body}</chart>`).children[0]).toEqual({
      type: 'chart',
      props: { type: 'bar' },
      value: body,
    })
  })

  it.each(['normal', 'loose'] as const)('keeps unknown tags as ordinary text in %s mode', (mode) => {
    const ast = parse('Before <unknown id="1">**bold**</unknown> after', { mode })
    expect(ast.children[0]).toEqual({
      type: 'paragraph',
      children: [
        { type: 'text', value: 'Before <unknown id="1">' },
        { type: 'strong', children: [{ type: 'text', value: 'bold' }] },
        { type: 'text', value: '</unknown> after' },
      ],
    })
  })

  it.each(['toString', 'constructor', 'hasOwnProperty'])('keeps prototype-like unknown tags as text: %s', (name) => {
    const source = `<${name}>x</${name}>`
    expect(parse(source).children[0]?.children).toEqual([{ type: 'text', value: source }])
  })

  it('preserves prototype-like attribute names without mutating object prototypes', () => {
    const ast = parse('<product __proto__="safe" constructor="value">')
    expect(Object.prototype.hasOwnProperty.call(ast.children[0]?.props, '__proto__')).toBe(true)
    expect(ast.children[0]?.props?.__proto__).toBe('safe')
    expect(ast.children[0]?.props?.constructor).toBe('value')
    expect(parse(print(ast))).toEqual(ast)
  })

  it('keeps unknown quoted delimiters as text and round-trips them', () => {
    const source = 'Before <unknown title=">">x</unknown> after'
    const ast = parse(source)
    expect(ast.children[0]?.children).toEqual([{ type: 'text', value: source }])
    expect(parse(print(ast))).toEqual(ast)
  })

  it('reports configured syntax errors with stable codes and locations in normal mode', () => {
    const cases: Array<[string, string]> = [
      ['<product id="1" id="2">', 'DUPLICATE_ATTRIBUTE'],
      ['<product id=1>', 'INVALID_ATTRIBUTE'],
      ['<callout>x</chart>', 'MISMATCHED_CLOSE'],
      ['<callout>x', 'UNCLOSED_NODE'],
      ['</callout>', 'UNEXPECTED_CLOSE'],
      ['</product>', 'UNEXPECTED_CLOSE'],
      ['<callout title="x>', 'UNCLOSED_MARKER'],
      ['</callout extra>', 'INVALID_MARKER'],
      ['[[box', 'UNCLOSED_MARKER'],
    ]
    for (const [source, code] of cases) {
      try {
        parse(source)
        expect.fail('expected parse() to throw')
      } catch (error) {
        expect(error).toBeInstanceOf(JzayMarkError)
        expect((error as JzayMarkError).code).toBe(code)
        expect((error as JzayMarkError).location?.line).toBe(1)
      }
    }
  })

  it('keeps the first duplicate attribute in loose mode', () => {
    expect(parse('<product id="first" id="second">', { mode: 'loose' }).children).toEqual([{
      type: 'product',
      props: { id: 'first' },
    }])
  })

  it('preserves a tag with invalid attributes as text in loose mode', () => {
    const source = '<callout id=1>**body**</callout>'
    expect(parse(source, { mode: 'loose' }).children[0]).toEqual({
      type: 'paragraph',
      children: [{ type: 'text', value: source }],
    })
  })

  it('preserves an extra configured closing tag as text in loose mode', () => {
    expect(parse('x</callout>y', { mode: 'loose' }).children[0]).toEqual({
      type: 'paragraph',
      children: [{ type: 'text', value: 'x</callout>y' }],
    })
  })

  it('turns only the mismatched inner opening into text in loose mode', () => {
    configure({ nodes: { a: { body: 'parse' }, b: { body: 'parse' } } })
    expect(parse('<a><b>**body**</a>', { mode: 'loose' }).children).toEqual([{
      type: 'a',
      children: [{
        type: 'paragraph',
        children: [
          { type: 'text', value: '<b>' },
          { type: 'strong', children: [{ type: 'text', value: 'body' }] },
        ],
      }],
    }])
  })

  it('preserves unclosed and malformed configured tags in loose mode', () => {
    const unclosed = parse('<callout>**body**', { mode: 'loose' })
    expect(unclosed.children[0]).toEqual({
      type: 'paragraph',
      children: [
        { type: 'text', value: '<callout>' },
        { type: 'strong', children: [{ type: 'text', value: 'body' }] },
      ],
    })
    expect(parse('<callout title="x>', { mode: 'loose' }).children[0]).toEqual({
      type: 'paragraph',
      children: [{ type: 'text', value: '<callout title="x>' }],
    })
  })

  it.each(['normal', 'loose'] as const)('round-trips incomplete unknown tags without absorbing the printer newline in %s mode', (mode) => {
    configure({ nodes: {} })
    const ast = parse('<a', { mode })
    expect(parse(print(ast), { mode })).toEqual(ast)
  })

  it('round-trips an incomplete configured tag in loose mode without absorbing the printer newline', () => {
    configure({ nodes: { a: { body: 'parse' } } })
    const ast = parse('<a', { mode: 'loose' })
    expect(parse(print(ast), { mode: 'loose' })).toEqual(ast)
  })

  it('does not merge one unknown tag across a later opening angle bracket in loose mode', () => {
    configure({ nodes: { a: { body: 'parse' } } })
    const ast = parse('a<b\n</a>', { mode: 'loose' })
    expect(parse(print(ast), { mode: 'loose' })).toEqual(ast)
  })

  it('does not absorb a Markdown container marker as the end of an incomplete tag', () => {
    configure({ nodes: { a: { body: 'parse' } } })
    const ast = parse('><a\na', { mode: 'loose' })
    expect(parse(print(ast), { mode: 'loose' })).toEqual(ast)
  })

  it('does not recognize custom syntax inside inline or fenced code', () => {
    const ast = parse('`<callout>x</callout>`\n\n```txt\n@command(id:"1")\n```')
    expect(ast.children[0]?.children?.[0]).toEqual({ type: 'inlineCode', value: '<callout>x</callout>' })
    expect(ast.children[1]).toEqual({ type: 'code', props: { lang: 'txt' }, value: '@command(id:"1")' })
  })

  it('normalizes inline-code line endings to their printable Markdown value', () => {
    const ast = parse('`\n=`')
    expect(ast.children[0]?.children?.[0]).toEqual({ type: 'inlineCode', value: ' =' })
    expect(parse(print(ast))).toEqual(ast)
  })

  it('lets a raw close delimiter end the node even when Markdown sees code', () => {
    const ast = parse('<chart>\n```txt\nraw\n</chart>')
    expect(ast.children[0]).toEqual({ type: 'chart', value: '\n```txt\nraw\n' })
  })

  it('treats backslash-escaped syntax as text', () => {
    const ast = parse('\\<callout>text\\</callout>')
    expect(ast.children[0]?.children).toEqual([{ type: 'text', value: '<callout>text</callout>' }])
  })

  it('rejects invalid options and unsupported AST versions', () => {
    expect(() => parse('text', { mode: 'other' as 'normal' })).toThrowError(/模式/)
    expect(() => parse('text', { version: 'v2' as 'v1' })).toThrowError(/v2/)
    expect(() => parse('text', { safe: true } as never)).toThrowError(
      expect.objectContaining({ code: 'INVALID_OPTIONS' }),
    )
    expect(() => parse('text', { mode: 'loose', extra: true } as never)).toThrowError(
      expect.objectContaining({ code: 'INVALID_OPTIONS' }),
    )
  })

  it('reports source locations correctly for CR-only line endings', () => {
    configure({ nodes: { a: { body: 'parse' }, b: { body: 'parse' } } })
    try {
      parse('<a>\r</b>')
      expect.fail('expected parse() to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(JzayMarkError)
      expect((error as JzayMarkError).location).toEqual({ line: 2, column: 1, offset: 4 })
    }
  })

  it('continues parsing after an invalid body-none tag in loose mode', () => {
    const ast = parse('before <product id=1> **after**', { mode: 'loose' })
    expect(ast.children[0]?.children).toEqual([
      { type: 'text', value: 'before <product id=1> ' },
      { type: 'strong', children: [{ type: 'text', value: 'after' }] },
    ])
  })
})

describe('print', () => {
  beforeEach(configureLanguage)

  it('prints system and node-specific syntax', () => {
    expect(print({
      version: 'v1',
      type: 'document',
      children: [
        { type: 'product', props: { active: true, id: '1' } },
        { type: 'command', props: { enabled: true, id: '100' } },
      ],
    })).toBe('<product active id="1">\n\n@command(enabled,id:"100")\n')
  })

  it('prints parsed and raw bodies with their configured syntax', () => {
    expect(print(parse('<callout>\n# Title\n</callout>'))).toBe('<callout>\n# Title\n</callout>\n')
    expect(print(parse('[[box]]**text**[[/box]]'))).toBe('[[box]]\n**text**\n[[/box]]\n')
    expect(print(parse('<chart>\n a  \n</chart>'))).toBe('<chart>\n a  \n</chart>\n')
  })

  it('round-trips backslash-escaped attribute values', () => {
    const source = '<product label="他说 \\"你好\\"，路径 C:\\\\tmp" 颜色="红">'
    const ast = parse(source)
    expect(ast.children[0]?.props).toEqual({ label: '他说 "你好"，路径 C:\\tmp', 颜色: '红' })
    expect(parse(print(ast))).toEqual(ast)
  })

  it('keeps semantic stability through parse, print, parse', () => {
    const source = [
      '# Demo',
      '',
      'Before <callout kind="tip">**hello** <product id="7"></callout> after.',
      '',
      '[[box format="json"]]{"x": 1}[[/box]]',
    ].join('\n')
    const first = parse(source)
    expect(parse(print(first))).toEqual(first)
  })

  it('prints GFM autolinks in a form that reparses as the same link', () => {
    const ast = parse('a@.a')
    expect(print(ast)).toBe('[a@.a](mailto:a@.a)\n')
    expect(parse(print(ast))).toEqual(ast)
  })

  it('prints references when their matching definitions are present', () => {
    const ast = parse('[text][id]\n\n[id]: /url\n\nnote[^n]\n\n[^n]: body')
    expect(parse(print(ast))).toEqual(ast)
  })

  it('uses a safe Markdown marker when custom syntax overrides the preferred marker', () => {
    configure({ nodes: { star: { body: 'none', syntax: { open: '*' } } } })
    const ast = parse('_safe_')
    expect(print(ast)).toBe('_safe_\n')
    expect(parse(print(ast))).toEqual(ast)
  })

  it('selects safe heading, list, and fenced-code forms under Markdown conflicts', () => {
    configure({
      nodes: {
        hash: { body: 'none', syntax: { open: '#' } },
        dash: { body: 'none', syntax: { open: '-' } },
        tick: { body: 'none', syntax: { open: '`' } },
      },
    })
    for (const source of ['Title\n=====', '+ item', '~~~js\ncode\n~~~']) {
      const ast = parse(source)
      expect(parse(print(ast))).toEqual(ast)
    }
  })

  it('preserves supplementary Unicode characters next to escaped Markdown boundaries', () => {
    configure({ nodes: {} })
    fc.assert(fc.property(fc.integer({ min: 0x10000, max: 0x10ffff }), (codePoint) => {
      const source = `*~*${String.fromCodePoint(codePoint)}`
      const ast = parse(source)
      expect(parse(print(ast))).toEqual(ast)
    }))
  })

  it('keeps user text that resembles raw or encoded internal tokens', () => {
    const ast: JzayAst = {
      version: 'v1',
      type: 'document',
      children: [{
        type: 'paragraph',
        children: [{
          type: 'text',
          value: 'JZAYMARKPRINTTOKENQZQ0Z &#x4A;ZAYMARKPRINTTOKENQZQ0Z 😀',
        }],
      }],
    }
    expect(parse(print(ast))).toEqual(ast)
  })

  it('escapes configured syntax when it appears as literal text', () => {
    configure({
      nodes: {
        command: { body: 'none', syntax: { open: '@command' } },
        word: { body: 'parse', syntax: { open: 'BEGIN', close: 'END' } },
      },
    })
    const ast: JzayAst = {
      version: 'v1',
      type: 'document',
      children: [{
        type: 'paragraph',
        children: [{ type: 'text', value: 'literal @command and BEGINinsideEND' }],
      }],
    }
    const output = print(ast)
    expect(output).toContain('\\@command')
    expect(output).toContain('\\BEGIN')
    expect(parse(output)).toEqual(ast)
  })

  it('round-trips literal syntax preceded by arbitrary backslashes', () => {
    configure({ nodes: { command: { body: 'none', syntax: { open: '@command' } } } })
    fc.assert(fc.property(fc.integer({ min: 0, max: 12 }), (slashes) => {
      const ast: JzayAst = {
        version: 'v1',
        type: 'document',
        children: [{
          type: 'paragraph',
          children: [{ type: 'text', value: `before ${'\\'.repeat(slashes)}@command after` }],
        }],
      }
      expect(parse(print(ast))).toEqual(ast)
    }))
  })

  it('escapes raw closing delimiters without changing the AST value', () => {
    for (let slashes = 0; slashes <= 8; slashes += 1) {
      const ast: JzayAst = {
        version: 'v1',
        type: 'document',
        children: [{ type: 'chart', value: `before${'\\'.repeat(slashes)}</chart>after\\path` }],
      }
      const output = print(ast)
      expect(output).toContain('\\</chart>')
      expect(parse(output)).toEqual(ast)
    }
  })

  it('turns all Markdown raw HTML fragments into text nodes', () => {
    configure({ nodes: {} })
    const source = '<!-- note -->\n\n<!doctype html>'
    const ast = parse(source)
    expect(JSON.stringify(ast)).not.toContain('"type":"html"')
    expect(ast.children).toEqual([
      { type: 'paragraph', children: [{ type: 'text', value: '<!-- note -->' }] },
      { type: 'paragraph', children: [{ type: 'text', value: '<!doctype html>' }] },
    ])
    expect(parse(print(ast))).toEqual(ast)
  })

  it.each(['<!a', '<!-- unfinished', '<?pi'])('wraps an incomplete raw HTML fragment as printable text: %s', (source) => {
    configure({ nodes: {} })
    const ast = parse(source)
    expect(ast.children[0]?.type).toBe('paragraph')
    expect(parse(print(ast))).toEqual(ast)
  })

  it('round-trips declaration-like plain text and its preceding backslashes', () => {
    configure({ nodes: {} })
    for (let slashes = 0; slashes <= 8; slashes += 1) {
      const ast: JzayAst = {
        version: 'v1',
        type: 'document',
        children: [{
          type: 'paragraph',
          children: [{ type: 'text', value: `${'\\'.repeat(slashes)}<!~>` }],
        }],
      }
      expect(parse(print(ast))).toEqual(ast)
    }
  })

  it('round-trips parse-body nodes in their block and inline placements', () => {
    const block: JzayAst = {
      version: 'v1',
      type: 'document',
      children: [{
        type: 'callout',
        children: [{ type: 'paragraph', children: [{ type: 'text', value: 'block' }] }],
      }],
    }
    const inline: JzayAst = {
      version: 'v1',
      type: 'document',
      children: [{
        type: 'paragraph',
        children: [
          { type: 'text', value: 'before ' },
          { type: 'callout', children: [{ type: 'text', value: 'inline' }] },
          { type: 'text', value: ' after' },
        ],
      }],
    }
    expect(parse(print(block))).toEqual(block)
    expect(parse(print(inline))).toEqual(inline)
  })

  it('rejects invalid versions, unknown nodes, and unprintable props', () => {
    expect(() => print({ version: 'v2', type: 'document', children: [] } as unknown as JzayAst)).toThrowError(/v2/)
    expect(() => print({ version: 'v1', type: 'document', children: [{ type: 'unknown' }] })).toThrowError(/尚未配置/)
    expect(() => print({ version: 'v1', type: 'document', children: [{ type: 'toString' }] })).toThrowError(
      expect.objectContaining({ code: 'UNKNOWN_NODE' }),
    )
    expect(() => print({
      version: 'v1',
      type: 'document',
      children: [{ type: 'product', props: { count: 2 } }],
    })).toThrowError(/字符串或 true/)
  })

  it.each([
    { version: 'v1', type: 'document', children: [{ type: 'document', children: [] }] },
    { version: 'v1', type: 'document', children: [{ type: 'heading', props: { depth: 9 }, children: [{ type: 'text', value: 'x' }] }] },
    { version: 'v1', type: 'document', children: [{ type: 'heading', props: { depth: 1, extra: 'lost' }, children: [{ type: 'text', value: 'x' }] }] },
    { version: 'v1', type: 'document', children: [{ type: 'paragraph', value: 'lost', children: [{ type: 'text', value: 'x' }] }] },
    { version: 'v1', type: 'document', children: [{ type: 'text', value: 'x', props: {} }] },
    { version: 'v1', type: 'document', children: [{ type: 'paragraph' }] },
    { version: 'v1', type: 'document', children: [{ type: 'paragraph', children: [] }] },
    { version: 'v1', type: 'document', children: [{ type: 'paragraph', children: [{ type: 'text', value: '' }] }] },
    { version: 'v1', type: 'document', children: [{ type: 'paragraph', children: [{ type: 'text', value: 'a' }, { type: 'text', value: 'b' }] }] },
    { version: 'v1', type: 'document', children: [{ type: 'paragraph', children: [{ type: 'emphasis', children: [] }] }] },
    { version: 'v1', type: 'document', children: [{ type: 'product', children: [] }] },
    { version: 'v1', type: 'document', children: [{ type: 'callout' }] },
    { version: 'v1', type: 'document', children: [{ type: 'chart' }] },
    { version: 'v1', type: 'document', children: [{ type: 'chart', value: 'x', children: [] }] },
    { version: 'v1', type: 'document', children: [{ type: 'text', value: 'root text' }] },
    { version: 'v1', type: 'document', children: [{ type: 'list', props: { ordered: false }, children: [{ type: 'paragraph', children: [] }] }] },
    { version: 'v1', type: 'document', children: [{ type: 'list', props: { ordered: false, start: 7, spread: false }, children: [] }] },
    { version: 'v1', type: 'document', children: [{ type: 'list', props: { ordered: false }, children: [] }] },
    { version: 'v1', type: 'document', children: [{ type: 'listItem', props: {}, children: [] }] },
    { version: 'v1', type: 'document', children: [{ type: 'code', props: { meta: 'x' }, value: 'code' }] },
    { version: 'v1', type: 'document', children: [{ type: 'paragraph', children: [{ type: 'inlineCode', value: 'a\nb' }] }] },
    { version: 'v1', type: 'document', children: [{ type: 'code', props: {}, value: 'code' }] },
    { version: 'v1', type: 'document', children: [{ type: 'paragraph', children: [{ type: 'text', value: '\0' }] }] },
    { version: 'v1', type: 'document', children: [{ type: 'code', value: '\0' }] },
    { version: 'v1', type: 'document', children: [{ type: 'paragraph', children: [{ type: 'link', props: { url: '/x', title: '' }, children: [{ type: 'text', value: 'x' }] }] }] },
    { version: 'v1', type: 'document', children: [{ type: 'paragraph', children: [{ type: 'linkReference', props: { identifier: 'id', label: 'id', referenceType: 'full' }, children: [{ type: 'text', value: 'x' }] }] }] },
    { version: 'v1', type: 'document', children: [{ type: 'product', props: {} }] },
    { version: 'v1', type: 'document', children: [{ type: 'table', props: { align: [null] }, children: [] }] },
    { version: 'v1', type: 'document', children: [{ type: 'table', props: { align: [null, null] }, children: [{ type: 'tableRow', children: [{ type: 'tableCell', children: [{ type: 'text', value: 'x' }] }] }] }] },
    { version: 'v1', type: 'document', children: [{ type: 'callout', children: [{ type: 'text', value: 'block child' }] }] },
    { version: 'v1', type: 'document', children: [{ type: 'paragraph', children: [{ type: 'callout', children: [{ type: 'paragraph', children: [{ type: 'text', value: 'inline child' }] }] }] }] },
    { version: 'v1', type: 'document', children: [{ type: 'paragraph', children: [{ type: 'heading', props: { depth: 1 }, children: [] }] }] },
  ])('rejects AST shapes that would otherwise lose data', (ast) => {
    expect(() => print(ast as JzayAst)).toThrowError(expect.objectContaining({ code: 'INVALID_AST' }))
  })

  it('rejects props when syntax has no props placeholder', () => {
    configure({ nodes: { mark: { body: 'none', syntax: { open: '@mark' } } } })
    expect(() => print({
      version: 'v1',
      type: 'document',
      children: [{ type: 'mark', props: { id: '1' } }],
    })).toThrowError(/没有 \{props\}/)
  })

  it('round-trips many inline values', () => {
    fc.assert(fc.property(
      fc.string({ unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz 0123456789'.split('')), maxLength: 80 }),
      (value) => {
        const ast = parse(`<callout label="x">${value}</callout>`)
        expect(parse(print(ast))).toEqual(ast)
      },
    ))
  })

  it('round-trips arbitrary string attributes through backslash escaping', () => {
    fc.assert(fc.property(fc.string({ maxLength: 60 }), (value) => {
      const ast: JzayAst = {
        version: 'v1',
        type: 'document',
        children: [{ type: 'product', props: { value } }],
      }
      expect(parse(print(ast))).toEqual(ast)
    }))
  })

  it('round-trips arbitrary raw values through delimiter escaping', () => {
    fc.assert(fc.property(fc.string({ maxLength: 100 }), (value) => {
      const ast: JzayAst = {
        version: 'v1',
        type: 'document',
        children: [{ type: 'chart', value }],
      }
      expect(parse(print(ast))).toEqual(ast)
    }))
  })

  it('keeps NUL data in raw custom bodies because it bypasses Markdown semantics', () => {
    const ast: JzayAst = {
      version: 'v1',
      type: 'document',
      children: [{ type: 'chart', value: 'before\0after' }],
    }
    expect(parse(print(ast))).toEqual(ast)
  })
})
