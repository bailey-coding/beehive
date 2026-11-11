/**
 * The mirror descriptor: all the edge (workers/api/mirror.ts) ever sends the shadow router. Sanitized at the source, so a raw
 * request, its headers, credentials, query string and body never leave the edge toward the router, let alone toward candidates.
 */
import { z } from 'zod';
import { MAX_TEMPLATE_CHARS, MAX_TEMPLATE_SEGMENTS, ROUTE_WORD } from './route-template';

/** Set on every request the router sends (candidates, baseline); the edge never mirrors a request that carries it (no loop). */
export const MIRROR_MARKER_HEADER = 'x-beehive-mirror';

/** Only methods whose baseline answer can be fetched without a second write */
export const MIRROR_METHODS = ['GET', 'HEAD'] as const;

/** '/' or '/' + 1-8 segments, each a route word or ':id' */
function isTemplateShaped(path: string): boolean {
  if (path === '/') return true;
  if (!path.startsWith('/') || path.length > MAX_TEMPLATE_CHARS) return false;
  const segments = path.slice(1).split('/');
  return segments.length <= MAX_TEMPLATE_SEGMENTS && segments.every((s) => s === ':id' || ROUTE_WORD.test(s));
}

export const MirrorDescriptorSchema = z
  .object({
    v: z.literal(1),
    method: z.enum(MIRROR_METHODS),
    path: z.string().refine(isTemplateShaped, 'path is not a route template'),
  })
  .strict();

export type MirrorDescriptor = z.infer<typeof MirrorDescriptorSchema>;

export function parseMirrorDescriptor(body: unknown): MirrorDescriptor | null {
  const parsed = MirrorDescriptorSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
}
