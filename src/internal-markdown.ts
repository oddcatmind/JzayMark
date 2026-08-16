export interface InternalMarkdownNode {
  type: string
  value?: string
  children?: InternalMarkdownNode[]
  position?: {
    start: { line: number; column: number; offset?: number }
    end: { line: number; column: number; offset?: number }
  }
  [key: string]: unknown
}

