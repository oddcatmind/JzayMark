export const AST_VERSION = 'v1' as const

export type AstVersion = typeof AST_VERSION
export type JsonPrimitive = null | boolean | number | string
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }
export type Props = Record<string, JsonValue>

export interface JzayNode {
  type: string
  props?: Props
  value?: JsonValue
  children?: JzayNode[]
}

export interface JzayAst {
  version: AstVersion
  type: 'document'
  children: JzayNode[]
}

export function createAst(children: JzayNode[]): JzayAst {
  return { version: AST_VERSION, type: 'document', children }
}
