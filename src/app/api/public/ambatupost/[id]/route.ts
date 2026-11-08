import { getDream, editDream, deleteDream } from '../../../../../lib/dreams';
import { validDreamId, DreamError } from '../../../../../lib/dream-validation';
import { dreamHeaders, dreamViewer, readDreamBody, dreamResponse, dreamFailure, dreamOptions } from '../../../../../lib/dream-http';
import { NextResponse } from 'next/server';
type Context = { params: Promise<{ id: string }> };
export const OPTIONS = dreamOptions;
async function idFrom(context: Context) {
  const { id } = await context.params;
  if (!validDreamId(id)) throw new DreamError('DREAM_UNAVAILABLE', 404);
  return id;
}
export async function GET(request: Request, context: Context) {
  try { const viewer = await dreamViewer(request); return dreamResponse(await getDream(await idFrom(context), viewer)); }
  catch (error) { return dreamFailure(error); }
}
export async function PATCH(request: Request, context: Context) {
  try { const author = (await dreamViewer(request, true))!; return dreamResponse(await editDream(await idFrom(context), author, await readDreamBody(request))); }
  catch (error) { return dreamFailure(error); }
}
export async function DELETE(request: Request, context: Context) {
  try { const author = (await dreamViewer(request, true))!; const operation = await deleteDream(await idFrom(context), author); return operation ? dreamResponse(operation,202) : new NextResponse(null, { status: 204, headers: dreamHeaders }); }
  catch (error) { return dreamFailure(error); }
}
