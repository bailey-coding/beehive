/**
 * Cloudflare Artifacts API Client
 * 
 * Fetches repository contents and commit information from Cloudflare Artifacts.
 * This is used to get the candidate's source code for Workers Builds previews.
 * 
 * Note: Cloudflare Artifacts is currently in beta and API documentation is limited.
 * This implementation uses the available endpoints and falls back to reasonable defaults.
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Artifacts repository information
 */
export interface ArtifactsRepository {
  id: string;
  name: string;
  namespace: string;
  full_name: string;
  default_branch: string;
  created_at: string;
}

/**
 * Commit information from Artifacts
 */
export interface ArtifactsCommit {
  sha: string;
  message: string;
  author: {
    name: string;
    email: string;
  };
  timestamp: string;
  url: string;
}

/**
 * File entry from Artifacts
 */
export interface ArtifactsFile {
  path: string;
  mode: string;
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  size?: number;
  content?: string; // Base64 encoded for files
  download_url?: string;
}

/**
 * Repository contents response
 */
export interface ArtifactsContentsResponse {
  repository: ArtifactsRepository;
  commit: ArtifactsCommit;
  tree: ArtifactsFile[];
  path: string;
}

/**
 * Environment with Artifacts access
 */
export interface ArtifactsEnv {
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN?: string;
}

// ============================================================================
// Constants
// ============================================================================

const ARTIFACTS_API_BASE = 'https://api.cloudflare.com/client/v4';

// ============================================================================
// API Client
// ============================================================================

/**
 * Artifacts API Client
 */
class ArtifactsClient {
  private accountId: string;
  private apiToken: string;
  
  constructor(env: ArtifactsEnv) {
    if (!env.CLOUDFLARE_ACCOUNT_ID) {
      throw new Error('CLOUDFLARE_ACCOUNT_ID is required');
    }
    if (!env.CLOUDFLARE_API_TOKEN) {
      throw new Error('CLOUDFLARE_API_TOKEN is required for Artifacts API');
    }
    
    this.accountId = env.CLOUDFLARE_ACCOUNT_ID;
    this.apiToken = env.CLOUDFLARE_API_TOKEN;
  }

  /**
   * Generic Artifacts API request
   */
  private async artifactsRequest<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: any
  ): Promise<T> {
    const url = `${ARTIFACTS_API_BASE}${path}`;
    
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.apiToken}`,
      'Content-Type': 'application/json',
    };

    const options: RequestInit = {
      method,
      headers,
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Artifacts API error ${response.status}: ${errorText}`);
    }

    const data = await response.json() as any;
    
    if (!data.success) {
      const errors = data.errors?.map((e: any) => e.message).join(', ') || 'Unknown error';
      throw new Error(`Artifacts API returned success=false: ${errors}`);
    }

    return data.result || data;
  }

  /**
   * Get repository information
   */
  async getRepository(namespace: string, repoName: string): Promise<ArtifactsRepository> {
    try {
      const path = `/accounts/${this.accountId}/artifacts/repositories/${namespace}/${repoName}`;
      return this.artifactsRequest<ArtifactsRepository>('GET', path);
    } catch (error) {
      console.error(`[Artifacts] Error getting repository ${namespace}/${repoName}:`, error);
      throw error;
    }
  }

  /**
   * Get commit information
   */
  async getCommit(
    namespace: string,
    repoName: string,
    commitSha: string
  ): Promise<ArtifactsCommit> {
    try {
      const path = `/accounts/${this.accountId}/artifacts/repositories/${namespace}/${repoName}/commits/${commitSha}`;
      return this.artifactsRequest<ArtifactsCommit>('GET', path);
    } catch (error) {
      console.error(`[Artifacts] Error getting commit ${commitSha}:`, error);
      throw error;
    }
  }

  /**
   * Get repository contents at a specific path and commit
   */
  async getContents(
    namespace: string,
    repoName: string,
    commitSha: string,
    path: string = ''
  ): Promise<ArtifactsContentsResponse> {
    try {
      const encodedPath = path ? `/${encodeURIComponent(path)}` : '';
      const apiPath = `/accounts/${this.accountId}/artifacts/repositories/${namespace}/${repoName}/contents${encodedPath}?ref=${commitSha}`;
      return this.artifactsRequest<ArtifactsContentsResponse>('GET', apiPath);
    } catch (error) {
      console.error(`[Artifacts] Error getting contents at ${path}:`, error);
      throw error;
    }
  }

  /**
   * Get the full repository tree (recursive)
   */
  async getFullTree(
    namespace: string,
    repoName: string,
    commitSha: string,
    maxDepth: number = 10
  ): Promise<ArtifactsFile[]> {
    const allFiles: ArtifactsFile[] = [];
    const client = this;
    
    async function fetchRecursive(currentPath: string, depth: number): Promise<void> {
      if (depth > maxDepth) {
        console.warn(`[Artifacts] Max depth ${maxDepth} reached at ${currentPath}`);
        return;
      }

      try {
        const contents = await client.getContents(namespace, repoName, commitSha, currentPath);
        
        for (const item of contents.tree) {
          if (item.type === 'file') {
            allFiles.push({
              ...item,
              path: currentPath ? `${currentPath}/${item.path}` : item.path,
            });
          } else if (item.type === 'dir') {
            await fetchRecursive(
              currentPath ? `${currentPath}/${item.path}` : item.path,
              depth + 1
            );
          }
        }
      } catch (error) {
        console.error(`[Artifacts] Error fetching recursive contents at ${currentPath}:`, error);
      }
    }

    await fetchRecursive('', 0);
    return allFiles;
  }

  /**
   * Get a specific file's content
   */
  async getFileContent(
    namespace: string,
    repoName: string,
    commitSha: string,
    filePath: string
  ): Promise<string> {
    try {
      const contents = await this.getContents(namespace, repoName, commitSha, filePath);
      
      // Find the file in the tree
      const file = contents.tree.find(f => f.path === filePath);
      
      if (!file) {
        throw new Error(`File ${filePath} not found at commit ${commitSha}`);
      }

      if (file.type !== 'file') {
        throw new Error(`Path ${filePath} is not a file`);
      }

      // If content is provided as base64, decode it
      if (file.content) {
        return atob(file.content);
      }

      // If download_url is provided, fetch it
      if (file.download_url) {
        const response = await fetch(file.download_url, {
          headers: {
            'Authorization': `Bearer ${this.apiToken}`,
          },
        });
        
        if (!response.ok) {
          throw new Error(`Failed to download file: ${response.status}`);
        }
        
        return await response.text();
      }

      throw new Error(`No content or download_url available for file ${filePath}`);
      
    } catch (error) {
      console.error(`[Artifacts] Error getting file content ${filePath}:`, error);
      throw error;
    }
  }

  /**
   * Get worker configuration file (wrangler.toml or package.json)
   */
  async getWorkerConfig(
    namespace: string,
    repoName: string,
    commitSha: string
  ): Promise<{ name: string; main: string; compatibilityDate: string } | null> {
    try {
      // Try to get wrangler.toml
      const tomlContent = await this.getFileContent(namespace, repoName, commitSha, 'wrangler.toml');
      
      // Parse TOML (simplified - in production use a proper TOML parser)
      const config: any = {};
      const lines = tomlContent.split('\n');
      
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('name =')) {
          config.name = trimmed.split('=')[1].trim().replace(/['"]/g, '');
        } else if (trimmed.startsWith('main =')) {
          config.main = trimmed.split('=')[1].trim().replace(/['"]/g, '');
        } else if (trimmed.startsWith('compatibility_date =')) {
          config.compatibilityDate = trimmed.split('=')[1].trim().replace(/['"]/g, '');
        }
      }

      if (config.name && config.main) {
        return {
          name: config.name,
          main: config.main,
          compatibilityDate: config.compatibilityDate || '2026-10-09',
        };
      }

      // Try package.json if wrangler.toml doesn't have the info
      const packageJsonContent = await this.getFileContent(namespace, repoName, commitSha, 'package.json');
      const packageJson = JSON.parse(packageJsonContent);
      
      if (packageJson.name && packageJson.main) {
        return {
          name: packageJson.name,
          main: packageJson.main,
          compatibilityDate: '2026-10-09',
        };
      }

      return null;
      
    } catch (error) {
      console.error(`[Artifacts] Error getting worker config:`, error);
      return null;
    }
  }
}

// ============================================================================
// Exports
// ============================================================================

export { ArtifactsClient };
