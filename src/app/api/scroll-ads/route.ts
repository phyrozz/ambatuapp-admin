import { NextResponse } from 'next/server';
import { requireAdmin } from '../../../lib/api-auth';
import { adminErrorStatus } from '../../../lib/studio-api';
import { adFields, createAd, createUploadedAd, deleteAdImage, formFields, hydrateAd, listAds, uploadAdImage } from '../../../lib/scroll-ads';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  try { await requireAdmin(request); return NextResponse.json(await listAds(new URL(request.url).searchParams.get('cursor'))); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to load ads.' }, { status: adminErrorStatus(error, 500) }); }
}
export async function POST(request: Request) {
  let uploaded: string | undefined;
  try {
    await requireAdmin(request);
    if (!request.headers.get('content-type')?.startsWith('multipart/form-data')) return NextResponse.json(await createAd(adFields(await request.json())), { status: 201 });
    await requireAdmin(request, { module: 'scroll-ads', action: 'upload' });
    const form = await request.formData();
    const fields = formFields(form), file = form.get('image');
    if (!(file instanceof File)) throw new Error('Choose a banner image.');
    uploaded = await uploadAdImage(file);
    const ad = await createUploadedAd(fields, uploaded);
    uploaded = undefined;
    return NextResponse.json(await hydrateAd(ad), { status: 201 });
  } catch (error) {
    await deleteAdImage(uploaded);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to save ad.' }, { status: adminErrorStatus(error, 400) });
  }
}
