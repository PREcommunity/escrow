export type ImmutableReferences = Record<string, Array<{ start: number; length: number }>>;

export function normalizeImmutableReferences(
  bytecode: string,
  immutableReferences: ImmutableReferences,
): string {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(bytecode)) {
    throw new Error('Runtime bytecode is not valid hexadecimal data.');
  }

  const normalized = bytecode.slice(2).toLowerCase().split('');
  for (const references of Object.values(immutableReferences)) {
    for (const reference of references) {
      const start = reference.start * 2;
      const end = (reference.start + reference.length) * 2;
      if (end > normalized.length) {
        throw new Error('Compiler immutable reference is outside runtime bytecode.');
      }
      normalized.fill('0', start, end);
    }
  }

  return `0x${normalized.join('')}`;
}
