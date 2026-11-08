import { dreamViewer, dreamResponse, dreamFailure, dreamOptions } from '../../../../../lib/dream-http';
import { mediaEnabled } from '../../../../../lib/dream-storage';
export const OPTIONS = dreamOptions;
export async function GET(request: Request) {
  try { await dreamViewer(request); return dreamResponse({ available: true, textLimit: 2000, attachmentsEnabled: mediaEnabled(), attachmentLimit:25, imageByteLimit:10485760, videoByteLimit:209715200, videoDurationLimit:3600 }); }
  catch (error) { return dreamFailure(error); }
}
