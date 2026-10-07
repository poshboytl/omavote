/** Error carrying a diagnostic code for a rejected protocol object or envelope. */
export class SchemaError extends Error {
  constructor(
    message: string,
    readonly code: string = "MALFORMED",
  ) {
    super(message);
    this.name = "SchemaError";
  }
}

/** Fatal problem with the replay input itself (not a protocol rejection). */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}
