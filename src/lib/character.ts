export type CharacterStatus = 'Published' | 'Draft';
export type Character = { id: string; name: string; title: string; bio: string; status: CharacterStatus; imageKey?: string; imageUrl?: string; tags: string[]; updated: string };
