export type SoundFields = { name: string; category: string };

export function soundFields(body: Record<string, unknown>): SoundFields {
  const name = typeof body.name === 'string' ? body.name.normalize('NFKC').trim() : '';
  const category = typeof body.category === 'string' ? body.category.normalize('NFKC').trim() : '';
  if (!name || name.length > 80) throw new Error('Enter a sound name up to 80 characters.');
  if (!category || category.length > 48) throw new Error('Enter a category up to 48 characters.');
  return { name, category };
}

export function soundColor(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 3 ? value : fallback % 4;
}

export function soundAudioUrl(origin: string, id: string) {
  return new URL(`/api/public/sounds/${encodeURIComponent(id)}/audio`, origin).toString();
}

export function soundResponse(id: string, data: Record<string, unknown>, audioUrl: string) {
  return {
    id,
    name: typeof data.name === 'string' ? data.name : '',
    category: typeof data.category === 'string' ? data.category : 'Other',
    color: soundColor(data.color, 0),
    audioUrl,
    createdAt: (data.createdAt as { toDate?: () => Date } | undefined)?.toDate?.().toISOString() ?? null,
  };
}
