# JzayMark

[English](./README.md) | 简体中文

一个以 Markdown 为基准的轻量自定义标记语言生成器。

让你以最简洁、灵活的方式定义各种形式的自定义标签。

## 核心 API 词典

| API | 用途 | 输入 | 返回 | 出错时 |
| --- | --- | --- | --- | --- |
| `configure(config)` | 设置全局默认规则和自定义标签 | `config: { defaults?, nodes }` | `DeepReadonly<JzayMarkConfig>` | 抛出 `JzayMarkError`：`INVALID_CONFIG`（配置无效） |
| `parse(text, options?)` | 将 Markdown 与自定义标签转为标准 AST | `text: string`；`options?: { version?, mode?: 'normal' \| 'loose' }` | `JzayAst` | 正常模式会反馈已配置标签的语法错误：`INVALID_MARKER`、`UNCLOSED_MARKER`、`INVALID_ATTRIBUTE`、`DUPLICATE_ATTRIBUTE`、`UNEXPECTED_CLOSE`、`MISMATCHED_CLOSE`、`UNCLOSED_NODE`；两种模式都会反馈：`INVALID_SOURCE`、`INVALID_OPTIONS`、`UNSUPPORTED_VERSION`、`UNSUPPORTED_MARKDOWN` |
| `print(ast)` | 将标准 AST 反向输出为 Markdown 与自定义标签 | `ast: JzayAst` | `string` | 抛出 `JzayMarkError`：`UNSUPPORTED_VERSION`（版本）、`UNKNOWN_NODE`（节点未配置）、`INVALID_AST`（AST 无效）、`UNPRINTABLE_PROP`（属性无法输出） |

`JzayMarkError` 包含 `code`、`message` 和可选的 `location: { line, column, offset }`；`code` 的类型为导出的 `JzayMarkErrorCode`。

`parse()` 的 options 只接受 `version` 和 `mode`；未知选项会报 `INVALID_OPTIONS`，不会静默忽略。

## 一、安装

```bash
npm install jzaymark
```

## 二、快速开始

### 2.1 在任意位置创建一个配置文件

```ts
// jzaymark.config.ts
import { configure, parse, print } from 'jzaymark'

configure({
  defaults: {
    // 所有未单独设置 props 的 node 默认使用 color="red" 风格
    props: {
      separator: ' ',
      assign: '=',
      quote: '"',
    },
  },

  nodes: {
    // 继承 defaults：<example level="info">正文</example>
    // parse：正文继续解析 Markdown 和其他自定义标签
    example: {
      body: 'parse',
    },

    // 使用独立的标签风格：[[example2 format="json"]]正文[[/example2]]
    // body 不写时默认为 raw，正文不解析并保存在 value
    example2: {
      syntax: {
        open: '[[example2 {props}]]',
        close: '[[/example2]]',
      },
    },

    // 使用独立的标签和属性风格：@example3(id:"100",enabled)
    // none：单标签，没有正文
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

以后统一从这个配置文件引入：

```ts
import { parse, print } from './jzaymark.config'
```

- 系统语法固定为 `<name>...</name>`；node 未设置 `syntax` 时自动使用该格式。
- `defaults` 只设置全局属性格式，不能修改系统语法和 `body`。
- node 中的 `syntax.open` 是完整开始标签模板，`{props}` 表示属性插入位置。
- 没有属性时，`{props}` 及其紧邻的一个空白会自动移除。
- `syntax.close` 是有正文标签的完整结束标签。
- 反斜杠是统一转义符，`syntax.open` 和 `syntax.close` 不能以反斜杠开头，也不能包含换行。
- `syntax.close` 不能是 `syntax.open` 的前缀，避免开始标签被误判为结束标签。
- `body: 'none'` 没有正文，只需要设置 `syntax.open`。
- `props` 可以在 node 中按字段覆盖 `defaults.props`。
- `separator`、`assign`、`quote` 都必须是互不相同的单字符；`assign` 和 `quote` 不能是空白，反斜杠保留为统一转义符。

`body` 有三种形式：

| `body` | 标签形式 | 正文结果 |
| --- | --- | --- |
| `raw` 或不写 | 成对标签 | 不解析正文，解码语法转义后保存在 `value` |
| `parse` | 成对标签 | 解析到 `children`，支持 Markdown 和自定义标签嵌套 |
| `none` | 单标签 | 没有正文，只保留 `props` |

属性无需提前定义。带值属性必须使用当前 `quote` 包裹并记录为字符串，只有属性名的属性记录为 `true`。属性值使用反斜杠转义：`\"` 表示引号，`\\` 表示反斜杠。`raw` 正文也使用反斜杠表示字面量结束标签，`print()` 会自动完成编码。

### 2.2 文本转 AST

原生 Markdown：

```ts
import { parse } from './jzaymark.config'

const ast = parse('# 标题')
```

```ts
{
  version: 'v1',
  type: 'document',
  children: [{
    type: 'heading',
    props: { depth: 1 },
    children: [{ type: 'text', value: '标题' }],
  }],
}
```

自定义标签：

```ts
import { parse } from './jzaymark.config'

const ast = parse(
  '<example level="info">正文 **加粗**</example>',
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
        { type: 'text', value: '正文 ' },
        { type: 'strong', children: [{ type: 'text', value: '加粗' }] },
      ],
    }],
  }],
}
```

`parse()` 默认使用 AST v1，也可以显式写成 `parse(text, { version: 'v1' })`。

### 2.3 AST 转文本

输出原生 Markdown：

```ts
import { print } from './jzaymark.config'

const markdown = print({
  version: 'v1',
  type: 'document',
  children: [{
    type: 'heading',
    props: { depth: 1 },
    children: [{ type: 'text', value: '标题' }],
  }],
})

// # 标题
```

输出自定义标签也完全一样：

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
      children: [{ type: 'text', value: '正文' }],
    }],
  }],
})

// <example level="info">
// 正文
// </example>
```

## 三、配置生效顺序

配置按以下顺序生效，后面的覆盖前面的：

```text
系统兜底 → defaults → node 单项配置
```

系统兜底为：

```ts
{
  syntax: '<name {props}>...</name>',
  props: { separator: ' ', assign: '=', quote: '"' },
  body: 'raw',
}
```

1. 没有任何设置时，使用系统兜底。
2. `configure.defaults.props` 按字段覆盖系统属性格式。
3. node 单项配置再按字段覆盖 `defaults`。
4. 同一层级重复或冲突时，配置表中后声明的 node 优先。
5. 自定义语法先于 Markdown 识别，因此后声明的 node 可以有意覆盖冲突的 Markdown 指令。

当冲突影响输出时，`print()` 会自动尝试等价的 Markdown 写法，例如将 `*强调*` 改为 `_强调_`。如果某个 AST 节点在当前配置下确实无法无损表达，`print()` 会报 `INVALID_AST`；被后续配置完全覆盖的旧 node 也不会被错误输出成另一个节点。

## 四、AST 标准结构

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

- `type`：节点名称。
- `props`：标签属性或 Markdown 节点信息。
- `value`：文本、代码或 `raw` 正文。
- `children`：解析后的子节点。
- `version`：只标记在根节点，目前为 `v1`。

官方不会轻易改变 AST 的核心结构。保留 `v1` 是为了在极特殊情况下必须调整结构时，解析和输出仍能明确识别版本；遇到不支持的版本会直接报错，不会静默误用。

`print()` 会严格检查各类标准节点允许的字段和值，并在返回前自动回读输出结果。只有重新解析后仍与输入 AST 一致才会返回；无法无损输出时会报 `INVALID_AST`，不会静默删除字段或修改数据。AST 中的块级与行内子节点必须放在对应位置；空 `text`、相邻 `text` 以及会被 Markdown 自动改写的非规范结构同样会被拒绝。JzayMark 不生成 `html` 节点；Markdown 中的原始 HTML 标签、注释和声明统一作为普通文字处理。

随包提供的 JSON Schema 用于检查不依赖配置的根结构和通用节点外形；标准节点细则、自定义 node 规则以及当前配置下能否无损输出，统一由 `print()` 完成最终校验。

### 正常模式与宽松模式

`parse()` 默认使用正常模式；需要容错行为时使用 `parse(text, { mode: 'loose' })`。

未知标签及其他原始 HTML 片段在两种模式下都只是普通文字，不生成自定义 AST 节点。宽松模式只对已配置标签进行容错；无法确认结构时保留原文，不删除内容，也不猜测修复结构。

| 场景 | 正常模式 `normal` | 宽松模式 `loose` |
| --- | --- | --- |
| 已配置且格式正确的标签 | 按 node 的 `syntax`、`props` 和 `body` 解析 | 处理相同 |
| 未配置的标签 | 开始标签和结束标签都作为普通文字，标签之间的 Markdown 正常解析 | 处理相同 |
| 重复属性 | 报 `DUPLICATE_ATTRIBUTE` | 保留第一个值，忽略后续同名属性 |
| 属性格式错误 | 报 `INVALID_ATTRIBUTE` | 将该标签的完整原文作为普通文本保留；单标签后面的内容继续解析，成对标签同时保留正文和结束标签 |
| 已配置标签出现多余的结束标签 | 报 `UNEXPECTED_CLOSE` | 只将该结束标签原文作为普通文字保留 |
| 已配置标签的结束标签不匹配 | 报 `MISMATCHED_CLOSE` | 从当前未闭合的内层开始标签起作为普通文字；外层正确标签仍正常解析。例如 `<a><b>正文</a>` 中 `<b>正文` 是 `<a>` 内的普通文字 |
| 标签未闭合 | 报 `UNCLOSED_NODE` | 将开始标签到当前父节点末尾或文本末尾的原文作为普通文本保留 |
| 标签格式或定界符不完整 | 报 `INVALID_MARKER` 或 `UNCLOSED_MARKER` | 将无法可靠识别的标签片段原样作为普通文本保留 |
| 已转义的标签 | 作为普通文本保留 | 处理相同 |
| 行内代码或代码块中的标签 | 作为代码原文保留 | 处理相同 |
| 输入类型或 AST 版本错误 | 直接报错 | 同样直接报错，不进行容错 |

JzayMark 只负责解析和打印；渲染、数据加载和业务校验由调用者实现。

需要 Node.js 18 或更高版本，同时支持 ESM、CommonJS 和 TypeScript。

## 五、FAQ

### 如何让自定义标签作为普通文本显示？

在自定义标签的 `open` 前加反斜杠。该规则适用于任意自定义语法，不限于 Markdown 可转义字符。成对标签需要分别转义开始和结束标签：

```text
\<example>普通文本\</example>
```

### 错误语法如何处理？

正常模式会通过带错误码和源码位置的 `JzayMarkError` 将问题反馈给调用者。需要自动容错时使用 `parse(text, { mode: 'loose' })`，具体规则见上方的“正常模式与宽松模式”。

### 行内代码和代码块中的自定义标签会被解析吗？

不会。Markdown 行内代码和围栏代码块中的内容始终按代码原文保留。

### `print()` 会完全还原原文吗？

`print()` 保证 `文本 → AST → 文本 → AST` 的语义一致，但会统一属性顺序、引号和 Markdown 格式，不保证逐字符还原原文。

如果普通 `text` 或 `raw` 正文中包含已配置的语法定界符，`print()` 会自动加入必要的反斜杠；再次 `parse()` 时会还原原值。

Emoji、生僻汉字及其他非 BMP Unicode 字符会先由内部占位符完整保护，再在输出后原样还原，不需要逐个配置字符。

### `configure()` 需要执行几次？

每个页面、Worker 或 Node.js 进程启动时执行一次即可。重复调用会使用新配置整体替换当前配置，不建议在业务运行过程中动态切换。
