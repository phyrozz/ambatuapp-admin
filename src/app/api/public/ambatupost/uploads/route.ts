import { dreamViewer,readDreamBody,dreamResponse,dreamFailure,dreamOptions } from '../../../../../lib/dream-http';
import { reserveDreamUpload } from '../../../../../lib/dream-uploads';
export const OPTIONS = dreamOptions;
export async function POST(request: Request) {
  try { return dreamResponse(await reserveDreamUpload((await dreamViewer(request,true))!,await readDreamBody(request)),201); }
  catch(error) { return dreamFailure(error); }
}
