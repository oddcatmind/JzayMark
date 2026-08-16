export interface SourceLocation {
  line: number
  column: number
  offset: number
}

export type JzayMarkErrorCode =
  | 'DUPLICATE_ATTRIBUTE'
  | 'INVALID_AST'
  | 'INVALID_ATTRIBUTE'
  | 'INVALID_CONFIG'
  | 'INVALID_MARKER'
  | 'INVALID_OPTIONS'
  | 'INVALID_SOURCE'
  | 'MISMATCHED_CLOSE'
  | 'UNCLOSED_MARKER'
  | 'UNCLOSED_NODE'
  | 'UNEXPECTED_CLOSE'
  | 'UNKNOWN_NODE'
  | 'UNPRINTABLE_PROP'
  | 'UNSUPPORTED_MARKDOWN'
  | 'UNSUPPORTED_VERSION'

export class JzayMarkError extends Error {
  readonly code: JzayMarkErrorCode
  readonly location?: SourceLocation

  constructor(code: JzayMarkErrorCode, message: string, location?: SourceLocation) {
    super(message)
    this.name = 'JzayMarkError'
    this.code = code
    if (location) this.location = location
  }
}

export function raise(code: JzayMarkErrorCode, message: string, location?: SourceLocation): never {
  throw new JzayMarkError(code, message, location)
}

export function locationAt(source: string, offset: number): SourceLocation {
  const before = source.slice(0, offset)
  const lines = before.split(/\r\n?|\n/u)
  return {
    line: lines.length,
    column: (lines[lines.length - 1]?.length ?? 0) + 1,
    offset,
  }
}
