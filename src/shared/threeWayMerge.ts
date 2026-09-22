// ─── Record-level 3-way merge ───
//
// Used by the Drive sync engine. `base` is the last snapshot both sides agreed on; without one the
// merge is an additive union that can only ever add rows.

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(record[key])}`
  )).join(',')}}`;
}

export function valuesEqual(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

export type ConflictPolicy = 'updatedAt' | 'local';

export function preferLocalOnTie<T>(local: T, remote: T, policy: ConflictPolicy): T {
  if (policy === 'local') return local;
  const localUpdatedAt = typeof (local as { updatedAt?: unknown }).updatedAt === 'number'
    ? (local as { updatedAt: number }).updatedAt : null;
  const remoteUpdatedAt = typeof (remote as { updatedAt?: unknown }).updatedAt === 'number'
    ? (remote as { updatedAt: number }).updatedAt : null;
  // Word forms have updatedAt in the current schema, but legacy rows can lack
  // it. A timestamp wins when present; an absent timestamp has a local tie.
  if (localUpdatedAt === null && remoteUpdatedAt === null) return local;
  if (localUpdatedAt === null) return remote;
  if (remoteUpdatedAt === null) return local;
  return remoteUpdatedAt > localUpdatedAt ? remote : local;
}

export function byId<T extends object>(rows: T[], idKey: keyof T): Map<string, T> {
  const output = new Map<string, T>();
  rows.forEach((item) => {
    const id = item[idKey];
    if (typeof id === 'string') output.set(id, item);
  });
  return output;
}

export function chooseThreeWay<T>(
  base: T | undefined,
  local: T | undefined,
  remote: T | undefined,
  policy: ConflictPolicy,
): T | undefined {
  if (!base) {
    if (!local) return remote;
    if (!remote) return local;
    return preferLocalOnTie(local, remote, policy);
  }
  if (!local && !remote) return undefined;
  if (!local) return valuesEqual(remote, base) ? undefined : remote;
  if (!remote) return valuesEqual(local, base) ? undefined : local;

  const localChanged = !valuesEqual(local, base);
  const remoteChanged = !valuesEqual(remote, base);
  if (!localChanged) return remote;
  if (!remoteChanged) return local;
  return preferLocalOnTie(local, remote, policy);
}

export function mergeRows<T extends object>(
  localRows: T[],
  remoteRows: T[],
  baseRows: T[] | null,
  idKey: keyof T,
  policy: ConflictPolicy,
): T[] {
  const local = byId(localRows, idKey);
  const remote = byId(remoteRows, idKey);
  const base = baseRows ? byId(baseRows, idKey) : new Map<string, T>();
  const ids = new Set([...local.keys(), ...remote.keys(), ...base.keys()]);
  return [...ids]
    .sort((left, right) => left.localeCompare(right))
    .flatMap((id) => {
      const resolved = chooseThreeWay(base.get(id), local.get(id), remote.get(id), policy);
      return resolved ? [resolved] : [];
    });
}
