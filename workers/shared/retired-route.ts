/**
 * Retired routes answer 410 with one body shape at the edge and the Spec DO, so the two cannot drift
 * (docs/plans/retire-execute-plan.md). `code` follows the snake_case convention of the other coded errors
 * (version_conflict, invalid_transition, busy).
 */
export const ROUTE_RETIRED = 'route_retired';

export const EXECUTE_RETIRED_MESSAGE =
  'POST /api/candidates/:id/execute is retired; use POST /api/candidates/:id/gate/pre-merge (gate runs)';

export function routeRetired(message: string): Response {
  return new Response(JSON.stringify({ success: false, error: message, code: ROUTE_RETIRED, timestamp: Date.now() }), {
    status: 410,
    headers: { 'Content-Type': 'application/json' },
  });
}
