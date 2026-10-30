/**
 * Cloudflare Artifacts client for fork creation and token management
 * 
 * Uses Cloudflare REST API to interact with Artifacts.
 * This is the integration point for real Artifacts repository operations.
 */

interface ArtifactsConfig {
  accountId: string;
  apiToken: string;
  namespace: string;
}

interface RepoInfo {
  id: string;
  name: string;
  remote: string;
  namespace: string;
}

interface ForkResult {
  repositoryId: string;
  repositoryName: string;
  remoteUrl: string;
  namespace: string;
  token: string;
  tokenExpiresAt: number;
}

// Cloudflare Artifacts REST API base URL
const ARTIFACTS_API_BASE = 'https://api.cloudflare.com/client/v4/accounts';

/**
 * Fail closed: a missing credential must surface as an error, never as a mock repo
 * that the ledger would record as real.
 */
function assertConfigured(config: ArtifactsConfig): void {
  const missing = [
    !config.accountId && 'CLOUDFLARE_ACCOUNT_ID',
    !config.apiToken && 'CLOUDFLARE_API_TOKEN',
    !config.namespace && 'namespace',
  ].filter(Boolean);
  if (missing.length > 0) {
    throw new Error(`Artifacts not configured: missing ${missing.join(', ')}`);
  }
}

/**
 * Create a write token for a repository
 * 
 * Uses Cloudflare Artifacts API: POST /accounts/:account_id/artifacts/namespaces/:namespace/tokens
 */
async function createRepoToken(
  config: ArtifactsConfig,
  repoName: string,
  scope: 'read' | 'write' = 'write',
  ttl: number = 3600
): Promise<{ token: string; expiresAt: number }> {
  assertConfigured(config);
  const url = `${ARTIFACTS_API_BASE}/${config.accountId}/artifacts/namespaces/${encodeURIComponent(config.namespace)}/tokens`;
  
  const requestBody = {
    scope,
    ttl,
    repo: repoName,
    // For repository-specific tokens, we can specify the repo
    // Based on Cloudflare Artifacts API documentation
    // Note: Cloudflare API expects 'repo' not 'repository_name'
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiToken}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to create token: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const result = await response.json() as { success: boolean; result?: { token?: string; plaintext?: string } };
    
    // The token is returned in the response
    if (!result.success || !result.result) {
      throw new Error(`Invalid token creation response: ${JSON.stringify(result)}`);
    }

    const tokenData = result.result;
    const token = tokenData.token || tokenData.plaintext;
    const expiresAt = Date.now() + (ttl * 1000);

    if (!token) {
      throw new Error('No token returned from Artifacts API');
    }

    return { token, expiresAt };
  } catch (error) {
    console.error('Error creating repo token:', error);
    throw error;
  }
}

/**
 * Create a fork (repository) in Cloudflare Artifacts
 * 
 * Uses Cloudflare Artifacts API: POST /accounts/:account_id/artifacts/namespaces/:namespace/repos
 */
async function createFork(
  config: ArtifactsConfig,
  baselineRepo: string,
  forkName: string,
  agentId: string
): Promise<ForkResult> {
  assertConfigured(config);
  const url = `${ARTIFACTS_API_BASE}/${config.accountId}/artifacts/namespaces/${encodeURIComponent(config.namespace)}/repos`;
  
  // Create the repository
  const repoBody = {
    name: forkName,
    // Note: Artifacts repos are independent, there's no explicit "fork from" in the API
    // The fork relationship is managed at the application level
  };

  try {
    // Step 1: Create the repository
    const repoResponse = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiToken}`,
      },
      body: JSON.stringify(repoBody),
    });

    if (!repoResponse.ok) {
      const errorText = await repoResponse.text();
      throw new Error(`Failed to create repository: ${repoResponse.status} ${repoResponse.statusText} - ${errorText}`);
    }

    const repoResult = await repoResponse.json() as { success: boolean; result?: { id?: string; name?: string } };
    
    if (!repoResult.success || !repoResult.result) {
      throw new Error(`Invalid repository creation response: ${JSON.stringify(repoResult)}`);
    }

    const repoInfo = repoResult.result;
    const repositoryName = repoInfo.name || forkName;
    const repositoryId = repoInfo.id || crypto.randomUUID();
    const remoteUrl = `https://${config.accountId}.artifacts.cloudflare.net/git/${config.namespace}/${repositoryName}.git`;

    // Step 2: Create a token for this repository
    const { token, expiresAt } = await createRepoToken(config, repositoryName, 'write', 3600);

    return {
      repositoryId,
      repositoryName,
      remoteUrl,
      namespace: config.namespace,
      token,
      tokenExpiresAt: expiresAt,
    };
  } catch (error) {
    console.error('Error creating fork:', error);
    throw error;
  }
}

export { createFork, createRepoToken };
export type { ArtifactsConfig, RepoInfo, ForkResult };
