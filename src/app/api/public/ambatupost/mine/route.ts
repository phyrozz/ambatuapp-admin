import { myDreams } from '../../../../../lib/dreams';
import { dreamViewer, dreamResponse, dreamFailure, dreamOptions } from '../../../../../lib/dream-http';
export const OPTIONS = dreamOptions;
export async function GET(request: Request) {
  try { return dreamResponse(await myDreams((await dreamViewer(request, true))!, new URL(request.url).searchParams.get('cursor'))); }
  catch (error) { return dreamFailure(error); }
}
