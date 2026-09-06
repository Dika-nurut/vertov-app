/** Serialize structured data without allowing a value to terminate the script tag. */
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}
