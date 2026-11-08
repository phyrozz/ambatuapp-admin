import { dreamViewer,dreamResponse,dreamFailure,dreamOptions } from '../../../../../../lib/dream-http';
import { dreamOperation } from '../../../../../../lib/dream-uploads';
export const OPTIONS = dreamOptions;
export async function GET(request: Request,context:{params:Promise<{id:string}>}) {
  try { return dreamResponse(await dreamOperation((await dreamViewer(request,true))!,(await context.params).id)); }
  catch(error) { return dreamFailure(error); }
}
