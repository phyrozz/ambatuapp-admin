// Temporary production migration freeze. Remove this file after the cutover is verified.
// Block every API method, including GET: some read endpoints also update Firestore.
export function proxy() {
  return Response.json(
    { error: 'MAINTENANCE' },
    { status: 503, headers: { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' } },
  );
}

export const config = {
  matcher: '/api/:path*',
};
