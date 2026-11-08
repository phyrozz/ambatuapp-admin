import { dreamViewer,readDreamBody,dreamResponse,dreamFailure,dreamOptions } from '../../../../../../lib/dream-http';
import { createDreamMediaSession } from '../../../../../../lib/dream-uploads';
export const OPTIONS = dreamOptions;
export async function POST(request: Request,context:{params:Promise<{id:string}>}) {
  try { return dreamResponse(await createDreamMediaSession((await context.params).id,await dreamViewer(request),await readDreamBody(request))); }
  catch(error) { return dreamFailure(error); }
}
