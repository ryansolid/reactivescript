// Native serverFunction cache identity (SF-7b-style): a lossless key for already wireCopy-validated arguments,
// independent of record insertion order. Owned by this package; the old prototype carried it as an upstream patch to
// ref/src/failure.ts, but upstream has no server-function factory cache that needs it.
export function wireCacheKey(args: readonly unknown[]): string {
  const encode = (value: unknown): unknown => {
    if (value === undefined) return ["undefined"];
    if (value === null) return ["null"];
    if (typeof value === "boolean") return ["boolean", value];
    if (typeof value === "string") return ["string", value];
    if (typeof value === "number") return ["number", Object.is(value, -0) ? "-0" : String(value)];
    if (Array.isArray(value)) return ["array", Array.from({ length: value.length }, (_, i) => Object.hasOwn(value, i) ? encode(value[i]) : ["hole"])];
    return ["record", Object.keys(value as object).sort().map(key => [key, encode((value as Record<string, unknown>)[key])])];
  };
  return JSON.stringify(encode(args));
}
