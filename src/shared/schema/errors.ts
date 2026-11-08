// Schema engine errors. Kept in its own module so the codec/validate/template
// modules can import it without a cycle through the public barrel (index.ts).
//
// Pure TypeScript: no Node, no DOM.

/** Thrown by encodeSchema / expandTemplate when a value cannot be encoded (Japanese message). */
export class SchemaValueError extends Error {
  readonly fieldId: string;
  constructor(fieldId: string, message: string) {
    super(message);
    this.name = 'SchemaValueError';
    this.fieldId = fieldId;
  }
}
