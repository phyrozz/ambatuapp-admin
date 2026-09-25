import { NextResponse } from 'next/server';
import { requireAdmin } from '../../../lib/api-auth';
import { inviteAdmin, listAdminUsers, removeAdminUser } from '../../../lib/cognito-admins';

export const runtime = 'nodejs';

function statusFor(error: unknown) {
  if (error instanceof Error && error.message === 'Unauthorized') return 401;
  if (error instanceof Error && error.message === 'Administrator access is required.') return 403;
  if (error instanceof Error && error.message === 'Admin authentication is not configured.') return 503;
  if ((error as { name?: string })?.name === 'UsernameExistsException') return 409;
  return 400;
}

function messageFor(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export async function GET(request: Request) {
  try {
    const currentAdmin = await requireAdmin(request);
    if (!process.env.COGNITO_ADMIN_USER_POOL_ID && !process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID) {
      return NextResponse.json({ error: 'Admin Cognito is not configured.' }, { status: 503 });
    }
    const admins = await listAdminUsers();
    return NextResponse.json({ admins, currentAdminSub: currentAdmin?.sub ?? null }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ error: messageFor(error, 'Could not load administrators.') }, { status: statusFor(error) });
  }
}

export async function POST(request: Request) {
  try {
    await requireAdmin(request);
    const body = await request.json() as Record<string, unknown>;
    const admin = await inviteAdmin(body.email);
    return NextResponse.json({ admin, message: admin.invited ? 'Invitation sent. The new administrator must set a password when signing in.' : 'Existing account added to the admin team.' }, { status: admin.invited ? 201 : 200 });
  } catch (error) {
    return NextResponse.json({ error: messageFor(error, 'Could not invite administrator.') }, { status: statusFor(error) });
  }
}

export async function DELETE(request: Request) {
  try {
    const currentAdmin = await requireAdmin(request);
    const body = await request.json() as Record<string, unknown>;
    const username = typeof body.username === 'string' ? body.username : '';
    if (!username) return NextResponse.json({ error: 'Choose an administrator to remove.' }, { status: 400 });
    const admins = await listAdminUsers();
    const target = admins.find(admin => admin.username === username);
    if (!target) return NextResponse.json({ error: 'Administrator not found.' }, { status: 404 });
    if (target.sub === currentAdmin?.sub) return NextResponse.json({ error: 'You cannot remove your own administrator account.' }, { status: 400 });
    if (admins.length < 2) return NextResponse.json({ error: 'At least one administrator must remain.' }, { status: 400 });
    await removeAdminUser(target.username);
    return NextResponse.json({ removed: target.username });
  } catch (error) {
    return NextResponse.json({ error: messageFor(error, 'Could not remove administrator.') }, { status: statusFor(error) });
  }
}
