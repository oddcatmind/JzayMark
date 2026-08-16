# JzayMark

[English](./README.md) | 简体中文

一个以 Markdown 为基准的轻量自定义标记语言生成器。

让你以最简洁、灵活的方式定义各种形式的自定义标签。

## 核心 API 词典

| API / 类型 | 做什么 | 输入或结构 | 返回 | 出错时 |
| --- | --- | --- | --- | --- |
| `configure(config)` | 设置全局属性规则和自定义标签 | `config: { defaults?, nodes }` | 冻结后的 `DeepReadonly<JzayMarkConfig>` | 抛出 `JzayMarkError`：`INVALID_CONFIG` |
| `parse(text, options?)` | 将 Markdown 与自定义标签转为标准 AST | `text: string`；`options` 只接受 `version`、`mode`，未知选项报 `INVALID_OPTIONS` | `JzayAst` | 正常模式可能报 `INVALID_MARKER`、`UNCLOSED_MARKER`、`INVALID_ATTRIBUTE`、`DUPLICATE_ATTRIBUTE`、`UNEXPECTED_CLOSE`、`MISMATCHED_CLOSE`、`UNCLOSED_NODE`；两种模式都可能报 `INVALID_SOURCE`、`INVALID_OPTIONS`、`UNSUPPORTED_VERSION`、`UNSUPPORTED_MARKDOWN` |
| `print(ast)` | 将标准 AST 反向输出为 Markdown 与自定义标签 | `ast: JzayAst` | `string` | 抛出 `UNSUPPORTED_VERSION`、`UNKNOWN_NODE`、`INVALID_AST` 或 `UNPRINTABLE_PROP` |
| `JzayMarkError` | 统一描述配置、解析和输出错误 | `code: JzayMarkErrorCode`、`message: string`、可选的 `location: { line, column, offset }` | — | `JzayMarkErrorCode` 是导出的错误码类型 |

## 一、快速开始

安装：

```bash
npm install jzaymark
```

无需配置即可转换原生 Markdown：

```ts
import { parse, print } from 'jzaymark'

const ast = parse('# Hello')
const text = print(ast) // # Hello
```

## 二、配置您的自定义语法标签

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
    // 继承默认形式：<example level="info">正文</example>
    // parse：正文继续解析 Markdown 和其他自定义标签
    example: {
      body: 'parse',
    },

    // 独立标签形式：[[example2 format="json"]]正文[[/example2]]
    // body 不写时默认为 raw，正文不解析并保存在 value
    example2: {
      syntax: {
        open: '[[example2 {props}]]',
        close: '[[/example2]]',
      },
    },

    // 独立标签和属性形式：@example3(id:"100",enabled)
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

以后在任何地方都只从这个配置文件引入：

```ts
import { parse, print } from './jzaymark.config'
```

### 2.2 配置详细说明

#### 系统默认形式

未单独设置时，每个 node 自动使用：

```ts
{
  syntax: '<name {props}>...</name>',
  props: { separator: ' ', assign: '=', quote: '"' },
  body: 'raw',
}
```

因此 `{ example: {} }` 默认使用 `<example>...</example>`；带属性时写作 `<example color="red">...</example>`。node 名必须以英文字母开头，后面可以使用英文字母、数字、`_`、`.`、`:`、`-`，且不能与标准 AST 节点名冲突。

#### `syntax`：标签长什么样

- `syntax.open` 是完整的开始标签模板，`{props}` 表示属性插入位置；不需要属性时可以省略 `{props}`。
- 没有属性时，`{props}` 及其紧邻的一个空白会自动移除。
- `syntax.close` 是有正文标签的完整结束标签；`body: 'none'` 不能设置 `close`。
- `{props}` 最多出现一次，且前后都要有固定语法；`close` 中不能出现 `{props}`。
- `open` 和 `close` 不能以反斜杠开头或包含换行，也不能相同；`close` 不能是 `open` 的前缀。

#### `props`：属性怎么分隔和赋值

| 字段 | 含义 | 默认值 |
| --- | --- | --- |
| `separator` | 多个属性之间的分隔符 | 空格 |
| `assign` | 属性名与属性值之间的赋值符 | `=` |
| `quote` | 属性值的包裹符 | `"` |

三个字段都必须是互不相同的单个 Unicode 字符，且不能使用反斜杠；`assign` 和 `quote` 不能是空白字符。

属性无需提前声明：`color="red"` 记录为 `{ color: 'red' }`，只有属性名的 `disabled` 记录为 `{ disabled: true }`。带值属性必须使用当前 `quote` 包裹。属性名不能包含空白、反斜杠或当前的 `separator`、`assign`、`quote`。

反斜杠是统一转义符。属性值中的 `\"` 表示引号、`\\` 表示反斜杠，也支持 `\n`、`\r`、`\t`；`print()` 会自动完成必要的编码。

#### `body`：正文如何处理

| `body` | 标签形式 | AST 中的正文 |
| --- | --- | --- |
| `raw` 或不写 | 成对标签 | 不继续解析，解码转义后保存在 `value` |
| `parse` | 成对标签 | 解析到 `children`，支持 Markdown 和自定义标签嵌套 |
| `none` | 单标签 | 没有正文，只保留 `props` |

`raw` 正文中的字面量结束标签也使用反斜杠转义，`print()` 会自动编码，下一次 `parse()` 会还原原值。

#### 配置生效顺序

配置按以下顺序生效，后面的覆盖前面的：

```text
系统默认 → defaults.props → node 单项配置
```

1. `configure.defaults.props` 按字段覆盖系统属性格式。
2. node 中的 `props` 再按字段覆盖 `defaults.props`；node 的 `syntax` 和 `body` 只作用于自身。
3. 同一层级出现重复或冲突的语法时，`nodes` 中后声明的 node 优先。
4. 自定义语法先于 Markdown 识别，所以后声明的 node 可以有意覆盖冲突的 Markdown 指令。

当冲突影响输出时，`print()` 会尝试等价的 Markdown 写法，例如将 `*强调*` 改为 `_强调_`。如果当前配置无法无损表达某个 AST 节点，或者一个旧 node 已被后续配置完全覆盖，`print()` 会报 `INVALID_AST`，不会输出错误内容。

## 三、文本转 AST

无论是原生 Markdown 还是自定义标签，均可一键转化：

```ts
import { parse } from './jzaymark.config'

const ast = parse(`
# 标题

<example level="info">正文 **加粗**</example>
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
      children: [{ type: 'text', value: '标题' }],
    },
    {
      type: 'example',
      props: { level: 'info' },
      children: [{
        type: 'paragraph',
        children: [
          { type: 'text', value: '正文 ' },
          { type: 'strong', children: [{ type: 'text', value: '加粗' }] },
        ],
      }],
    },
  ],
}
```

`parse()` 默认使用 AST v1，也可以显式传入 `parse(text, { version: 'v1' })`。

## 四、AST 转文本

AST 转文本同样简单高效：

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
      children: [{ type: 'text', value: '正文' }],
    }],
  }],
})

// <example level="info">
// 正文
// </example>
```

Markdown 节点与自定义节点使用同一个 `print()`，不需要区分输出方式。

## 五、AST 标准结构

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

标准示例：

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

- `type`：节点名称。
- `props`：标签属性或 Markdown 节点信息。
- `value`：文本、代码或 `raw` 正文。
- `children`：解析后的子节点。
- `version`：只标记在根节点，目前为 `v1`。

官方不会轻易改变 AST 的核心结构。保留 `v1` 是为了在极特殊情况下必须调整结构时仍能明确识别版本；不支持的版本会直接报错。

随包提供的 JSON Schema 用于检查不依赖配置的根结构和通用节点外形。标准节点细则、自定义 node 规则以及当前配置能否无损输出，由 `print()` 完成最终校验。

## 六、正常模式与宽松模式

`parse()` 默认使用正常模式；需要容错行为时使用 `parse(text, { mode: 'loose' })`。

未知标签及其他原始 HTML 片段在两种模式下都作为普通文字，不生成自定义 AST 节点。宽松模式只对已配置标签进行容错；无法确认结构时保留原文，不删除内容，也不猜测修复结构。

| 场景 | 正常模式 `normal` | 宽松模式 `loose` |
| --- | --- | --- |
| 已配置且格式正确的标签 | 按 node 的 `syntax`、`props` 和 `body` 解析 | 处理相同 |
| 未配置的标签 | 开始标签和结束标签都作为普通文字，标签之间的 Markdown 正常解析 | 处理相同 |
| 重复属性 | 报 `DUPLICATE_ATTRIBUTE` | 保留第一个值，忽略后续同名属性 |
| 属性格式错误 | 报 `INVALID_ATTRIBUTE` | 将该标签的完整原文作为普通文本保留；单标签后面的内容继续解析，成对标签同时保留正文和结束标签 |
| 已配置标签出现多余的结束标签 | 报 `UNEXPECTED_CLOSE` | 只将该结束标签原文作为普通文字保留 |
| 已配置标签的结束标签不匹配 | 报 `MISMATCHED_CLOSE` | 从当前未闭合的内层开始标签起作为普通文字，外层正确标签仍正常解析；例如 `<a><b>正文</a>` 中 `<b>正文` 是 `<a>` 内的普通文字 |
| 标签未闭合 | 报 `UNCLOSED_NODE` | 将开始标签到当前父节点末尾或文本末尾的原文作为普通文本保留 |
| 标签格式或定界符不完整 | 报 `INVALID_MARKER` 或 `UNCLOSED_MARKER` | 将无法可靠识别的标签片段原样作为普通文本保留 |
| 已转义的标签 | 作为普通文本保留 | 处理相同 |
| 行内代码或代码块中的标签 | 作为代码原文保留 | 处理相同 |
| 输入类型、未知 options 或 AST 版本错误 | 直接报错 | 同样直接报错，不进行容错 |

## 七、FAQ

### 如何让自定义标签作为普通文本显示？

在自定义标签的 `open` 前加反斜杠。成对标签需要分别转义开始和结束标签：

```text
\<example>普通文本\</example>
```

### 错误语法如何处理？

正常模式通过 `JzayMarkError` 把错误码、说明和可用的源码位置反馈给调用者。需要自动容错时使用 `parse(text, { mode: 'loose' })`，具体处理方式见第六章。

### 行内代码和代码块中的自定义标签会被解析吗？

不会。Markdown 行内代码和围栏代码块中的内容始终按代码原文保留。

### `print()` 会完全还原原文吗？

`print()` 保证 `文本 → AST → 文本 → AST` 的语义一致，但可能统一属性顺序、引号和 Markdown 格式，不保证逐字符还原原文。

返回文本前，`print()` 会自动重新解析并对比 AST。只有结果与输入一致才会返回；无法无损输出时会报 `INVALID_AST`，不会静默删除或修改数据。

### Emoji 和生僻汉字是否安全？

安全。Emoji、生僻汉字及其他非 BMP Unicode 字符会被完整保护并原样还原，不需要逐个配置。

### JzayMark 是否负责渲染？

不负责。JzayMark 只负责解析和打印；渲染、数据加载和业务校验由调用者实现。Markdown 中的原始 HTML 标签、注释和声明统一作为普通文字处理，不生成 `html` 节点。

### `configure()` 需要执行几次？

每个页面、Worker 或 Node.js 进程启动时执行一次即可。重复调用会用新配置整体替换当前配置，不建议在业务运行过程中动态切换。

### 支持哪些运行环境？

需要 Node.js 18 或更高版本，同时支持 ESM、CommonJS 和 TypeScript。
