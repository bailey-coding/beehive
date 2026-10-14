/**
 * Principal types shared by the edge (and, later, the fork-token endpoint).
 *
 * Read-only slice: only `master` and `service` principals with the `read` scope
 * are produced today. `session` and `write` are reserved so the fork-token work
 * can extend the interface without reshaping it.
 */

export type Scope = 'read' | 'write';

export interface Principal {
  kind: 'master' | 'service' | 'session';
  /** FK-valid actors.id; 'unknown' only for master without X-Actor-ID. */
  actorId: string;
  /** master: ['read','write']; write implies read. */
  scopes: Scope[];
  /** service: live actors.promotion_authority; master: true. Not enforced yet. */
  promotionAuthority: boolean;
  /** Write confinement (deferred); null = unconfined. */
  organizationId: string | null;
  serviceAccountId?: string;
  githubLogin?: string;
}
