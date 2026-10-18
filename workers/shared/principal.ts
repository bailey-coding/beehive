/**
 * Principal types shared by the edge (and, later, the fork-token endpoint).
 *
 * Produced today: `master`, `service` (always `read` only) and `user` (a `bh_usr_`
 * token of one human actor, RFC-0008). `session` is reserved so the fork-token work
 * can extend the interface without reshaping it.
 */

export type Scope = 'read' | 'write' | 'maintainer';

export interface Principal {
  kind: 'master' | 'service' | 'user' | 'session';
  /** FK-valid actors.id; 'unknown' only for master without X-Actor-ID. */
  actorId: string;
  /**
   * master: ['read','write']; write implies read, maintainer implies write. A user token's
   * stored scope maps read -> ['read'], read_write -> ['read','write'],
   * maintainer -> ['read','write','maintainer'].
   */
  scopes: Scope[];
  /** service: live actors.promotion_authority; master: true. Not enforced yet. */
  promotionAuthority: boolean;
  /** Write confinement (deferred); null = unconfined. */
  organizationId: string | null;
  serviceAccountId?: string;
  /** user: user_tokens.id of the presented token (never the token or its hash). */
  userTokenId?: string;
  githubLogin?: string;
}
