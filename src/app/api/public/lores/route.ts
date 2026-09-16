import { NextResponse } from 'next/server';
import { adminDb } from '../../../../lib/firebase-admin';
import { signedCharacterImageUrl } from '../../../../lib/s3-images';

export const runtime = 'nodejs';
const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=30' };
type Translation = { locale?: string; label?: string; title?: string; text?: string };
type LoreDocument = { id: string; title?: string; text?: string; translations?: Translation[]; tags?: string[]; imageKeys?: string[]; upvotes?: number; downvotes?: number; commentCount?: number };

export async function GET(request: Request) {
  if (!adminDb) return NextResponse.json({ error: 'Lore service is not configured.' }, { status: 503, headers });
  const url = new URL(request.url);
  const query = (url.searchParams.get('q') ?? '').trim().toLowerCase();
  const selectedTags = url.searchParams.getAll('tag').map(tag => tag.trim().toLowerCase()).filter(Boolean);
  const language = (url.searchParams.get('language') ?? '').trim().toLowerCase();
  const snapshot = await adminDb.collection('lores').where('status', '==', 'Published').get();
  const all: LoreDocument[] = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

  const tags = [...new Set(all.flatMap(item => Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === 'string') : []))].sort();
  const languages = new Map<string, string>();
  for (const item of all) for (const translation of (Array.isArray(item.translations) ? item.translations : []) as Translation[]) {
    if (translation.locale && translation.label) languages.set(translation.locale.toLowerCase(), translation.label);
  }

  const filtered = all.filter(item => {
    const translations = (Array.isArray(item.translations) ? item.translations : []) as Translation[];
    const itemTags = (Array.isArray(item.tags) ? item.tags : []).map(String).map(tag => tag.toLowerCase());
    const searchable = [item.title, item.text, ...translations.flatMap(entry => [entry.title, entry.text])].filter(Boolean).join(' ').toLowerCase();
    return (!query || searchable.includes(query))
      && (!selectedTags.length || selectedTags.every(tag => itemTags.includes(tag)))
      && (!language || language === 'original' || translations.some(entry => entry.locale?.toLowerCase() === language));
  });

  const lores = await Promise.all(filtered.map(async item => {
    const keys = Array.isArray(item.imageKeys) ? item.imageKeys.filter((key): key is string => typeof key === 'string') : [];
    return { id: item.id, title: item.title, text: item.text, translations: item.translations ?? [], tags: item.tags ?? [], imageUrls: await Promise.all(keys.map(signedCharacterImageUrl)), upvotes: item.upvotes ?? 0, downvotes: item.downvotes ?? 0, commentCount: item.commentCount ?? 0 };
  }));
  return NextResponse.json({ lores, facets: { tags, languages: [...languages].map(([locale, label]) => ({ locale, label })) } }, { headers });
}
