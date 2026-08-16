# JzayMark

English | [简体中文](./README.zh-CN.md)

A lightweight custom markup language builder based on Markdown.

Define custom tags in the simplest and most flexible way.

## Core API reference

| API | Purpose | Input | Returns | On error |
| --- | --- | --- | --- | --- |
| `configure(config)` | Set global defaults and custom tags | `config: { defaults?, nodes }` | `DeepReadonly<JzayMarkConfig>` | Throws `JzayMarkError`: `INVALID_CONFIG` (invalid configuration) |
| `parse(text, options?)` | Convert Markdown and custom tags into the standard AST | `text: string`; `options?: { version?, mode?: 'normal' \| 'loose' }` | `JzayAst` | Normal mode reports configured-tag syntax errors: `INVALID_MARKER`, `UNCLOSED_MARKER`, `INVALID_ATTRIBUTE`, `DUPLICATE_ATTRIBUTE`, `UNEXPECTED_CLOSE`, `MISMATCHED_CLOSE`, `UNCLOSED_NODE`; both modes report `INVALID_SOURCE`, `INVALID_OPTIONS`, `UNSUPPORTED_VERSION`, and `UNSUPPORTED_MARKDOWN` |
| `print(ast)` | Convert the standard AST back into Markdown and custom tags | `ast: JzayAst` | `string` | Throws `JzayMarkError`: `UNSUPPORTED_VERSION` (version), `UNKNOWN_NODE` (unconfigured node), `INVALID_AST` (invalid AST), `UNPRINTABLE_PROP` (unprintable attribute) |

`JzayMarkError` contains `code`, `message`, and an optional `location: { line, column, offset }`; `code` uses the exported `JzayMarkErrorCode` type.

`parse()` options accept only `version` and `mode`. Unknown options report `INVALID_OPTIONS` instead of being ignored silently.

## 1. Install

```bash
npm install jzaymark
```

## 2. Quick start

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
    // Inherits defaults: <example level="info">Body</example>
    // parse: parse Markdown and nested custom tags in the body
    example: {
      body: 'parse',
    },

    // Independent tag style: [[example2 format="json"]]Body[[/example2]]
    // Omitted body defaults to raw and is preserved in value
    example2: {
      syntax: {
        open: '[[example2 {props}]]',
        close: '[[/example2]]',
      },
    },

    // Independent tag and property style: @example3(id:"100",enabled)
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

Import everything through this file from now on:

```ts
import { parse, print } from './jzaymark.config'
```

- The system syntax is fixed as `<name>...</name>`; nodes without `syntax` use it automatically.
- `defaults` configures only the global attribute format; it cannot change system syntax or `body`.
- A node's `syntax.open` is the complete opening-tag template; `{props}` marks the attribute position.
- With no attributes, `{props}` and one adjacent whitespace character are removed automatically.
- `syntax.close` is the complete closing tag for a node with a body.
- Backslash is the universal escape character, so `syntax.open` and `syntax.close` cannot start with it or contain line breaks.
- `syntax.close` cannot be a prefix of `syntax.open`, preventing an opening tag from being mistaken for a closing tag.
- A `body: 'none'` node has no body and only needs `syntax.open`.
- Node-level `props` fields override matching `defaults.props` fields.
- `separator`, `assign`, and `quote` must each be one distinct character. `assign` and `quote` cannot be whitespace, and backslash is reserved as the universal escape character.

`body` has three forms:

| `body` | Tag form | Body result |
| --- | --- | --- |
| `raw` or omitted | Paired | Not parsed; stored in `value` after syntax escapes are decoded |
| `parse` | Paired | Parsed into `children`, including Markdown and nested custom tags |
| `none` | Single | No body; only `props` remain |

Attributes require no schema. Valued attributes must use the active `quote` and become strings, while bare attributes become `true`. Attribute values use backslash escaping: `\"` represents a quote and `\\` represents a backslash. Raw bodies also use backslash to represent a literal closing delimiter; `print()` performs this encoding automatically.

### 2.2 Text to AST

Native Markdown:

```ts
import { parse } from './jzaymark.config'

const ast = parse('# Title')
```

```ts
{
  version: 'v1',
  type: 'document',
  children: [{
    type: 'heading',
    props: { depth: 1 },
    children: [{ type: 'text', value: 'Title' }],
  }],
}
```

A custom tag:

```ts
import { parse } from './jzaymark.config'

const ast = parse(
  '<example level="info">Body with **bold** text</example>',
)
```

```ts
{
  version: 'v1',
  type: 'document',
  children: [{
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
  }],
}
```

`parse()` uses AST v1 by default. It can also be explicit: `parse(text, { version: 'v1' })`.

### 2.3 AST to text

Output native Markdown:

```ts
import { print } from './jzaymark.config'

const markdown = print({
  version: 'v1',
  type: 'document',
  children: [{
    type: 'heading',
    props: { depth: 1 },
    children: [{ type: 'text', value: 'Title' }],
  }],
})

// # Title
```

Outputting a custom tag works exactly the same way:

```ts
import { print } from './jzaymark.config'

const markdown = print({
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

## 3. Configuration precedence

Later levels override earlier levels:

```text
System fallback → defaults → node configuration
```

The system fallback is:

```ts
{
  syntax: '<name {props}>...</name>',
  props: { separator: ' ', assign: '=', quote: '"' },
  body: 'raw',
}
```

1. With no configuration, the system fallback applies.
2. `configure.defaults.props` overrides the system attribute format field by field.
3. Each node then overrides `defaults` field by field.
4. For duplicate or conflicting matches at the same level, the node declared later wins.
5. Custom syntax is recognized before Markdown, so a later node may intentionally override a conflicting Markdown construct.

When a conflict affects output, `print()` automatically tries an equivalent Markdown form, such as `_emphasis_` instead of `*emphasis*`. If an AST node truly cannot be represented losslessly under the active configuration, `print()` reports `INVALID_AST`. An older node fully shadowed by a later declaration is never emitted as the wrong node.

## 4. Standard AST structure

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

- `type`: node name.
- `props`: tag attributes or Markdown node metadata.
- `value`: text, code, or a `raw` body.
- `children`: parsed child nodes.
- `version`: present only on the root; currently `v1`.

The official AST core will not change lightly. The `v1` marker exists so parsing and printing can identify the structure if an exceptional future change is ever required. Unsupported versions fail explicitly instead of being used silently.

`print()` strictly validates the fields and values allowed by each standard node and automatically reparses its candidate output before returning it. Output is returned only when the reparsed AST matches the input; otherwise `INVALID_AST` is reported instead of silently dropping or changing data. Block and phrasing children must appear in the matching placement; empty or adjacent `text` nodes and other non-canonical structures that Markdown would rewrite are rejected as well. JzayMark does not generate `html` nodes; raw HTML tags, comments, and declarations in Markdown are all treated as plain text.

The bundled JSON Schema validates the configuration-independent document envelope and generic node shape. Standard-node details, custom-node rules, and lossless printability under the active configuration are enforced by `print()`.

### Normal and loose modes

`parse()` uses normal mode by default. Use `parse(text, { mode: 'loose' })` when error recovery is needed.

Unknown tags and other raw HTML fragments are plain text in both modes and never create custom AST nodes. Loose mode recovers only configured tags; when their structure cannot be identified reliably, it preserves the source without deleting content or guessing a repair.

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
| Invalid input type or AST version | Report the error | Report the same error without recovery |

JzayMark only parses and prints. Rendering, data loading, and business validation belong to the caller.

Requires Node.js 18 or newer. Supports ESM, CommonJS, and TypeScript.

## 5. FAQ

### How do I display custom tags as plain text?

Add a backslash before the custom tag's `open`. This works for every custom syntax, including delimiters that Markdown itself would not escape. Escape both the opening and closing tags for a paired tag:

```text
\<example>plain text\</example>
```

### How is invalid syntax handled?

Normal mode reports problems to the caller through a `JzayMarkError` containing an error code and source location. Use `parse(text, { mode: 'loose' })` for automatic recovery; see “Normal and loose modes” above for the exact rules.

### Are custom tags parsed inside inline or fenced code?

No. Content inside Markdown inline code and fenced code blocks is always preserved as code.

### Does `print()` reproduce the original source exactly?

`print()` guarantees semantic stability across `text → AST → text → AST`, but it may normalize attribute order, quotes, and Markdown formatting. Byte-for-byte reproduction is not guaranteed.

If plain `text` or a `raw` body contains configured syntax delimiters, `print()` adds the required backslashes automatically and the next `parse()` restores the original value.

Emoji, rare CJK characters, and other non-BMP Unicode characters are protected as complete internal tokens and restored unchanged after printing; no per-character configuration is required.

### How many times should `configure()` run?

Run it once when each page, Worker, or Node.js process starts. Calling it again replaces the current configuration as a whole, so dynamic switching during normal application work is not recommended.
