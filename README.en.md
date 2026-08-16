# JzayMark

[简体中文](./README.md) | English

A lightweight custom markup language generation engine based on Markdown.

Define your own markup language in the simplest and most flexible way.

With one configuration file, define `<x>hello</x>` or custom tags in any style, use them easily throughout your own system and ecosystem, and retain Markdown support.

## Core API reference

| API / type | What it does | Input or shape | Returns | On error |
| --- | --- | --- | --- | --- |
| `configure(config)` | Set global attribute rules and custom tags | `config: { defaults?, nodes }` | Frozen `DeepReadonly<JzayMarkConfig>` | Throws `JzayMarkError` with `INVALID_CONFIG` |
| `parse(text, options?)` | Convert Markdown and custom tags into the standard AST | `text: string`; `options` accepts only `version` and `mode`; unknown options report `INVALID_OPTIONS` | `JzayAst` | Normal mode may report `INVALID_MARKER`, `UNCLOSED_MARKER`, `INVALID_ATTRIBUTE`, `DUPLICATE_ATTRIBUTE`, `UNEXPECTED_CLOSE`, `MISMATCHED_CLOSE`, or `UNCLOSED_NODE`; both modes may report `INVALID_SOURCE`, `INVALID_OPTIONS`, `UNSUPPORTED_VERSION`, or `UNSUPPORTED_MARKDOWN` |
| `print(ast)` | Convert the standard AST back into Markdown and custom tags | `ast: JzayAst` | `string` | Throws `UNSUPPORTED_VERSION`, `UNKNOWN_NODE`, `INVALID_AST`, or `UNPRINTABLE_PROP` |
| `JzayMarkError` | Describe configuration, parsing, and printing errors consistently | `code: JzayMarkErrorCode`, `message: string`, and optional `location: { line, column, offset }` | — | `JzayMarkErrorCode` is the exported error-code type |

## 1. Quick start

Install:

```bash
npm install jzaymark
```

Native Markdown works without configuration:

```ts
import { parse, print } from 'jzaymark'

const ast = parse('# Hello')
const text = print(ast) // # Hello
```

## 2. Configure your custom syntax tags

### 2.1 Create one configuration file anywhere

```ts
// jzaymark.config.ts
import { configure, parse, print } from 'jzaymark'

configure({
  defaults: {
    // Nodes without their own props use the color="red" style
    props: {
      separator: ' ',
      assign: '=',
      quote: '"',
    },
  },

  nodes: {
    // Inherits the default form: <example level="info">Body</example>
    // parse: continue parsing Markdown and custom tags in the body
    example: {
      body: 'parse',
    },

    // Independent tag form: [[example2 format="json"]]Body[[/example2]]
    // Omitted body defaults to raw and is preserved in value
    example2: {
      syntax: {
        open: '[[example2 {props}]]',
        close: '[[/example2]]',
      },
    },

    // Independent tag and attribute form: @example3(id:"100",enabled)
    // none: a single tag with no body
    example3: {
      body: 'none',
      syntax: {
        open: '@example3({props})',
      },
      props: {
        separator: ',',
        assign: ':',
        quote: '"',
      },
    },
  },
})

export { parse, print }
```

Import only through this configuration file everywhere else:

```ts
import { parse, print } from './jzaymark.config'
```

### 2.2 Configuration details

#### System defaults

Every node uses the following form unless it overrides it:

```ts
{
  syntax: '<name {props}>...</name>',
  props: { separator: ' ', assign: '=', quote: '"' },
  body: 'raw',
}
```

Therefore, `{ example: {} }` uses `<example>...</example>` by default; with attributes, it becomes `<example color="red">...</example>`. A node name must start with an ASCII letter and may then contain ASCII letters, digits, `_`, `.`, `:`, or `-`. It cannot conflict with a standard AST node name.

#### `syntax`: what the tag looks like

- `syntax.open` is the complete opening-tag template. `{props}` marks the attribute position and can be omitted when attributes are not needed.
- With no attributes, `{props}` and one adjacent whitespace character are removed automatically.
- `syntax.close` is the complete closing tag for a node with a body. A `body: 'none'` node cannot define `close`.
- `{props}` may appear at most once and must have fixed syntax on both sides. It cannot appear in `close`.
- `open` and `close` cannot start with a backslash, contain line breaks, or be identical. `close` cannot be a prefix of `open`.

#### `props`: how attributes are separated and assigned

| Field | Meaning | Default |
| --- | --- | --- |
| `separator` | Delimiter between attributes | Space |
| `assign` | Assignment character between a name and value | `=` |
| `quote` | Wrapper around an attribute value | `"` |

Each field must be one distinct Unicode character, and none can be a backslash. `assign` and `quote` cannot be whitespace.

Attributes need no schema. `color="red"` becomes `{ color: 'red' }`, while the bare attribute `disabled` becomes `{ disabled: true }`. A valued attribute must use the active `quote`. Attribute names cannot contain whitespace, backslashes, or the active `separator`, `assign`, or `quote`.

Backslash is the universal escape character. In an attribute value, `\"` represents a quote and `\\` represents a backslash; `\n`, `\r`, and `\t` are also supported. `print()` adds the required encoding automatically.

#### `body`: how body content is handled

| `body` | Tag form | Body in the AST |
| --- | --- | --- |
| `raw` or omitted | Paired | Not parsed further; stored in `value` after escapes are decoded |
| `parse` | Paired | Parsed into `children`, including Markdown and nested custom tags |
| `none` | Single | No body; only `props` remain |

A literal closing delimiter inside a `raw` body also uses backslash escaping. `print()` encodes it automatically, and the next `parse()` restores the original value.

#### Configuration precedence

Configuration applies in this order, with later levels overriding earlier levels:

```text
System defaults → defaults.props → node configuration
```

1. `configure.defaults.props` overrides the system attribute format field by field.
2. A node's `props` then overrides `defaults.props` field by field. Its `syntax` and `body` affect only that node.
3. When syntax is duplicated or conflicts at the same level, the node declared later in `nodes` wins.
4. Custom syntax is recognized before Markdown, so a later node can intentionally override a conflicting Markdown construct.

When a conflict affects output, `print()` tries an equivalent Markdown form, such as `_emphasis_` instead of `*emphasis*`. If the active configuration cannot represent an AST node losslessly, or an older node is fully shadowed by a later declaration, `print()` reports `INVALID_AST` instead of emitting incorrect content.

## 3. Text to AST

Native Markdown and custom tags are converted together in one call:

```ts
import { parse } from './jzaymark.config'

const ast = parse(`
# Title

<example level="info">Body with **bold** text</example>
`.trim())
```

```ts
{
  version: 'v1',
  type: 'document',
  children: [
    {
      type: 'heading',
      props: { depth: 1 },
      children: [{ type: 'text', value: 'Title' }],
    },
    {
      type: 'example',
      props: { level: 'info' },
      children: [{
        type: 'paragraph',
        children: [
          { type: 'text', value: 'Body with ' },
          { type: 'strong', children: [{ type: 'text', value: 'bold' }] },
          { type: 'text', value: ' text' },
        ],
      }],
    },
  ],
}
```

`parse()` uses AST v1 by default. It can also be explicit: `parse(text, { version: 'v1' })`.

## 4. AST to text

Converting an AST back to text is just as simple and efficient:

```ts
import { print } from './jzaymark.config'

const text = print({
  version: 'v1',
  type: 'document',
  children: [{
    type: 'example',
    props: { level: 'info' },
    children: [{
      type: 'paragraph',
      children: [{ type: 'text', value: 'Body' }],
    }],
  }],
})

// <example level="info">
// Body
// </example>
```

Markdown nodes and custom nodes use the same `print()`; no output mode needs to be selected.

## 5. Standard AST structure

```ts
type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

interface JzayNode {
  type: string
  props?: Record<string, JsonValue>
  value?: JsonValue
  children?: JzayNode[]
}

interface JzayAst {
  version: 'v1'
  type: 'document'
  children: JzayNode[]
}
```

Example:

```ts
{
  version: 'v1',
  type: 'document',
  children: [{
    type: 'paragraph',
    children: [
      { type: 'text', value: 'Hello ' },
      { type: 'strong', children: [{ type: 'text', value: 'JzayMark' }] },
    ],
  }],
}
```

- `type`: node name.
- `props`: tag attributes or Markdown node metadata.
- `value`: text, code, or a `raw` body.
- `children`: parsed child nodes.
- `version`: present only on the root; currently `v1`.

The official AST core will not change lightly. The `v1` marker keeps versions identifiable if an exceptional structural change is ever required. Unsupported versions fail explicitly.

The bundled JSON Schema validates the configuration-independent document envelope and generic node shape. Standard-node details, custom-node rules, and lossless printability under the active configuration are enforced by `print()`.

## 6. Normal and loose modes

`parse()` uses normal mode by default. Use `parse(text, { mode: 'loose' })` when error recovery is needed.

Unknown tags and other raw HTML fragments are plain text in both modes and never create custom AST nodes. Loose mode recovers only configured tags. When their structure cannot be identified reliably, it preserves the source without deleting content or guessing a repair.

| Scenario | Normal mode `normal` | Loose mode `loose` |
| --- | --- | --- |
| Configured, valid tag | Parse with the node's `syntax`, `props`, and `body` | Same behavior |
| Unconfigured tag | Preserve both opening and closing tags as plain text while parsing Markdown between them normally | Same behavior |
| Duplicate attribute | Report `DUPLICATE_ATTRIBUTE` | Keep the first value and ignore later duplicates |
| Invalid attribute syntax | Report `INVALID_ATTRIBUTE` | Preserve the complete tag source as plain text; continue parsing after a single tag, and preserve the body and closing tag with a paired tag |
| Extra closing tag for a configured node | Report `UNEXPECTED_CLOSE` | Preserve only that closing tag source as plain text |
| Mismatched closing tag for a configured node | Report `MISMATCHED_CLOSE` | Preserve source from the currently open inner tag as plain text while allowing the valid outer tag to close; in `<a><b>body</a>`, `<b>body` is plain text inside `<a>` |
| Unclosed tag | Report `UNCLOSED_NODE` | Preserve the source from the opening tag to the end of its current parent or the end of the input as plain text |
| Invalid or incomplete tag delimiter | Report `INVALID_MARKER` or `UNCLOSED_MARKER` | Preserve the unrecognizable tag fragment exactly as plain text |
| Escaped tag | Preserve it as plain text | Same behavior |
| Tag inside inline or fenced code | Preserve it as code | Same behavior |
| Invalid input type, unknown options, or AST version | Report the error | Report the same error without recovery |

## 7. FAQ

### How do I display custom tags as plain text?

Add a backslash before the custom tag's `open`. Escape both the opening and closing tags for a paired tag:

```text
\<example>plain text\</example>
```

### How is invalid syntax handled?

Normal mode reports an error code, explanation, and available source location through `JzayMarkError`. Use `parse(text, { mode: 'loose' })` for automatic recovery; see section 6 for the exact behavior.

### Are custom tags parsed inside inline or fenced code?

No. Content inside Markdown inline code and fenced code blocks is always preserved as code.

### Does `print()` reproduce the original source exactly?

`print()` guarantees semantic stability across `text → AST → text → AST`, but it may normalize attribute order, quotes, and Markdown formatting. Byte-for-byte reproduction is not guaranteed.

Before returning text, `print()` reparses it and compares the resulting AST. It returns only when the result matches the input; otherwise it reports `INVALID_AST` instead of silently dropping or changing data.

### Are emoji and rare CJK characters safe?

Yes. Emoji, rare CJK characters, and other non-BMP Unicode characters are protected and restored intact without per-character configuration.

### Does JzayMark render content?

No. JzayMark only parses and prints. Rendering, data loading, and business validation belong to the caller. Raw HTML tags, comments, and declarations in Markdown are plain text and do not create `html` nodes.

### How many times should `configure()` run?

Run it once when each page, Worker, or Node.js process starts. Calling it again replaces the active configuration as a whole, so dynamic switching during normal application work is not recommended.

### Which runtimes are supported?

Node.js 18 or newer is required. ESM, CommonJS, and TypeScript are supported.
