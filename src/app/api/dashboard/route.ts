import { NextResponse } from 'next/server';
import { Timestamp } from 'firebase-admin/firestore';
import { requireAdmin } from '../../../lib/api-auth';
import { studioDb } from '../../../lib/studio-access';
import { studioError } from '../../../lib/studio-api';

export async function GET(request: Request) {
  try {
    await requireAdmin(request, { module: 'dashboard', action: 'view' });
    const profiles = studioDb().collection('playerProfiles');
    const now = Date.now();
    const since = (days: number) => Timestamp.fromMillis(now - days * 24 * 60 * 60 * 1000);
    const [registered, newProfiles, activeDay, activeWeek, activeMonth] = await Promise.all([
      profiles.count().get(),
      profiles.where('createdAt', '>=', since(7)).count().get(),
      profiles.where('lastActiveAt', '>=', since(1)).count().get(),
      profiles.where('lastActiveAt', '>=', since(7)).count().get(),
      profiles.where('lastActiveAt', '>=', since(30)).count().get(),
    ]);
    return NextResponse.json({
      registered: registered.data().count,
      newProfiles: newProfiles.data().count,
      activeDay: activeDay.data().count,
      activeWeek: activeWeek.data().count,
      activeMonth: activeMonth.data().count,
      asOf: new Date(now).toISOString(),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return studioError(error); }
}
