import { NextResponse } from 'next/server';
import { requireAdmin } from '../../../../lib/api-auth';
import { adminErrorStatus } from '../../../../lib/studio-api';
import { deleteAd, deleteAdImage, formFields, hydrateAd, updateUploadedAd, uploadAdImage } from '../../../../lib/scroll-ads';
export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
export async function PATCH(request: Request, context: Context) {
  let uploaded: string | undefined;
  try {
    await requireAdmin(request);
    const form = await request.formData(), fields = formFields(form), file = form.get('image');
    if (file instanceof File && file.size) {
      await requireAdmin(request, { module: 'scroll-ads', action: 'upload' });
      uploaded = await uploadAdImage(file);
    }
    const result = await updateUploadedAd((await context.params).id, fields, uploaded ?? null);
    if (!result) { await deleteAdImage(uploaded); uploaded = undefined; return NextResponse.json({ error: 'Ad not found.' }, { status: 404 }); }
    uploaded = undefined;
    await deleteAdImage(result.previous);
    return NextResponse.json(await hydrateAd(result.row));
  } catch (error) {
    await deleteAdImage(uploaded);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to save ad.' }, { status: adminErrorStatus(error, 400) });
  }
}
export async function DELETE(request: Request, context: Context) {
  try { await requireAdmin(request); return await deleteAd((await context.params).id) ? NextResponse.json({ ok: true }) : NextResponse.json({ error: 'Ad not found.' }, { status: 404 }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to delete ad.' }, { status: adminErrorStatus(error, 400) }); }
}
