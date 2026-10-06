// ─── Small type guards shared by the parsers ───

/** A plain object (not null, not an array): the shape every stored row and message starts as. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
