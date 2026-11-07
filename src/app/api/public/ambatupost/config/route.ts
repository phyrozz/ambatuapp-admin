import { dreamViewer, dreamResponse, dreamFailure, dreamOptions } from '../../../../../lib/dream-http';
export const OPTIONS = dreamOptions;
export async function GET(request: Request) {
  try { await dreamViewer(request); return dreamResponse({ available: true, textLimit: 2000, attachmentsEnabled: false }); }
  catch (error) { return dreamFailure(error); }
}
