import { NextResponse } from 'next/server';
import { requireAdmin } from '../../../lib/api-auth';
import { studioError } from '../../../lib/studio-api';
import { readChatSettings, saveChatSettings, validateLimits } from '../../../lib/chat-settings';

export async function GET(request: Request) {
  try {
    await requireAdmin(request, { module: 'settings', action: 'view' });
    return NextResponse.json(await readChatSettings(), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return studioError(error); }
}

export async function PUT(request: Request) {
  try {
    const actor = await requireAdmin(request, { module: 'settings', action: 'edit' });
    const body = await request.json();
    if (!Number.isSafeInteger(body?.version) || body.version < 0) throw new Error('studio.errors.chatSettingsInvalid');
    const limits = validateLimits(body.limits);
    return NextResponse.json(await saveChatSettings(limits, body.version, actor?.sub ?? 'local-preview'), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return studioError(error); }
}
