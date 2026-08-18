import type { JzayAst } from './ast.js'
import { configure as applyConfig, getConfig } from './config.js'
import type { DeepReadonly, JzayMarkConfig } from './config.js'
import { parseMarkdown, printMarkdown } from './markdown.js'
import type { ParseOptions } from './markdown.js'

export { AST_VERSION } from './ast.js'
export type {
  AstVersion,
  JsonPrimitive,
  JsonValue,
  JzayAst,
  JzayNode,
  Props,
} from './ast.js'
export type {
  BodyMode,
  DeepReadonly,
  DefaultsConfig,
  JzayMarkConfig,
  NodeConfig,
  PropsConfig,
  SyntaxConfig,
  SyntaxSugarMapper,
  SyntaxSugarMapping,
  SyntaxSugarMatch,
  SyntaxSugarRule,
} from './config.js'
export { JzayMarkError } from './diagnostics.js'
export type { JzayMarkErrorCode, SourceLocation } from './diagnostics.js'
export type { ParseMode, ParseOptions } from './markdown.js'

export function configure(config: JzayMarkConfig): DeepReadonly<JzayMarkConfig> {
  return applyConfig(config)
}

export function parse(source: string, options?: ParseOptions): JzayAst {
  return parseMarkdown(source, getConfig(), options)
}

export function print(ast: JzayAst): string {
  return printMarkdown(ast, getConfig())
}
