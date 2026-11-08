import { dreamViewer,dreamResponse,dreamFailure,dreamOptions } from '../../../../../../lib/dream-http';
import { dreamUpload,changeDreamUpload } from '../../../../../../lib/dream-uploads';
type Context = {params:Promise<{id:string}>};
export const OPTIONS = dreamOptions;
export async function GET(request: Request,context:Context) {
  try { return dreamResponse(await dreamUpload((await dreamViewer(request,true))!,(await context.params).id)); }
  catch(error) { return dreamFailure(error); }
}
export async function DELETE(request: Request,context:Context) {
  try { await changeDreamUpload((await dreamViewer(request,true))!,(await context.params).id,false); return dreamResponse({removed:true}); }
  catch(error) { return dreamFailure(error); }
}
export async function POST(request: Request,context:Context) {
  try { await changeDreamUpload((await dreamViewer(request,true))!,(await context.params).id,true); return dreamResponse({retrying:true}); }
  catch(error) { return dreamFailure(error); }
}
