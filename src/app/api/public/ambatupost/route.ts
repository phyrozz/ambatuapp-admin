import { createDream } from '../../../../lib/dreams';
import { dreamIdempotencyKey } from '../../../../lib/dream-validation';
import { dreamViewer, readDreamBody, dreamResponse, dreamFailure, dreamOptions } from '../../../../lib/dream-http';
export const OPTIONS = dreamOptions;
export async function POST(request: Request) {
  try {
    const author = (await dreamViewer(request, true))!;
    const key = dreamIdempotencyKey(request.headers.get('idempotency-key'));
    return dreamResponse(await createDream(author, await readDreamBody(request), key), 201);
  } catch (error) { return dreamFailure(error); }
}
