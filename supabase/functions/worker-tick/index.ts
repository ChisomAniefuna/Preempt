import { env } from '../_shared/env.ts';
import { handler, HttpError, json } from '../_shared/http.ts';
import { makeTickDeps, safeEqual } from '../_shared/deps.ts';
import { runTick } from '../_shared/tick.ts';

Deno.serve(handler(async (req) => {
  if (!safeEqual(req.headers.get('x-cron-secret') ?? '', env('CRON_SECRET'))) throw new HttpError(401, 'UNAUTHORIZED', 'Bad cron secret.');
  return json(await runTick(makeTickDeps()));
}));
