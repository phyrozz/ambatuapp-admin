import { NextResponse } from 'next/server';
import { isDevProfileWriter } from '../../../lib/dev-content-db';
import { dashboardCounts } from '../../../lib/dev-profiles';
import { Timestamp } from 'firebase-admin/firestore';
import { requireAdmin } from '../../../lib/api-auth';
import { studioDb } from '../../../lib/studio-access';
import { studioError } from '../../../lib/studio-api';

export async function GET(request: Request) {
  try {
    await requireAdmin(request, { module: 'dashboard', action: 'view' });
    const now = Date.now();
    if (isDevProfileWriter()) return NextResponse.json({ ...await dashboardCounts(now), asOf: new Date(now).toISOString() }, { headers: { 'Cache-Control': 'no-store' } });
    const profiles = studioDb().collection('playerProfiles');
    const since = (days: number) => Timestamp.fromMillis(now - days * 24 * 60 * 60 * 1000);
    const [registered, newProfiles, activeDay, activeWeek, activeMonth] = await Promise.all([
      profiles.count().get(),
      profiles.where('createdAt', '>=', since(7)).count().get(),
      profiles.where('lastActiveAt', '>=', since(1)).count().get(),
      profiles.where('lastActiveAt', '>=', since(7)).count().get(),
      profiles.where('lastActiveAt', '>=', since(30)).count().get(),
    ]);
    // Completed Philippine calendar days make the two seven-day periods comparable.
    const day = 24 * 60 * 60 * 1000;
    const phOffset = 8 * 60 * 60 * 1000;
    const today = Math.floor((now + phOffset) / day) * day - phOffset;
    const registrationTrend = await Promise.all(Array.from({ length: 14 }, async (_, index) => {
      const start = today - (14 - index) * day;
      const count = await profiles.where('createdAt', '>=', Timestamp.fromMillis(start))
        .where('createdAt', '<', Timestamp.fromMillis(start + day)).count().get();
      return { date: new Date(start + phOffset).toISOString().slice(0, 10), count: count.data().count };
    }));
    return NextResponse.json({
      registrationTrend,
      registered: registered.data().count,
      newProfiles: newProfiles.data().count,
      activeDay: activeDay.data().count,
      activeWeek: activeWeek.data().count,
      activeMonth: activeMonth.data().count,
      asOf: new Date(now).toISOString(),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return studioError(error); }
}
