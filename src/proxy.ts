import { NextResponse, type NextRequest } from 'next/server';

// Temporary production migration freeze. Remove this file after the cutover is verified.
// Block every API method, including GET: some read endpoints also update Firestore.
export function proxy(request: NextRequest) {
  // This read-only endpoint verifies the selected database while other APIs remain frozen.
  if (request.nextUrl.pathname.replace(/\/$/, '') === '/api/health'
    && (request.method === 'GET' || request.method === 'HEAD')) return NextResponse.next();
  return Response.json(
    { error: 'MAINTENANCE' },
    { status: 503, headers: { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } },
  );
}

export const config = {
  matcher: '/api/:path*',
};
