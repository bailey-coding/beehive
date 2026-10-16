/**
 * Beehive API Client
 * Handles all communication with the Beehive REST API
 */

import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse, AxiosError } from 'axios';
import { BeehiveConfig } from '../types/config';
import {
  ApiResponse,
  PaginatedResponse,
  HealthResponse,
  OrganizationResponse,
  CreateOrganizationRequest,
  ActorResponse,
  CreateActorRequest,
  UpdateActorTrustRequest,
  RepositoryResponse,
  CreateRepositoryRequest,
  SpecResponse,
  CreateSpecRequest,
  UpdateSpecStageRequest,
  CandidateResponse,
  CreateCandidateRequest,
  UpdateCandidateStageRequest,
  ClaimSpecRequest,
  ClaimSpecResponse,
  GateVerdictResponse,
  CreateGateVerdictRequest,
  TrialResponse,
  CreateTrialRequest,
  DecideTrialRequest,
  PromotionResponse,
  CreatePromotionRequest,
  IssueResponse,
  CreateIssueRequest,
  EntityHistoryResponse,
  EntityType,
  StateDumpResponse,
  QueueStatus,
  ArtifactsStatus,
} from '../types/api';

// Custom error class for API errors
export class BeehiveApiError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public responseData?: unknown,
    public endpoint?: string
  ) {
    super(message);
    this.name = 'BeehiveApiError';
  }
}

// Request options interface
export interface RequestOptions {
  actorId?: string;
  timeout?: number;
  signal?: AbortSignal;
}

/**
 * Beehive API Client
 * Provides typed methods for all API endpoints
 */
export class BeehiveClient {
  private client: AxiosInstance;
  private config: BeehiveConfig;

  constructor(config: BeehiveConfig) {
    this.config = config;
    
    // Ensure API URL ends with /api
    let baseURL = config.apiUrl || 'https://beehive.bz23711.workers.dev';
    if (!baseURL.endsWith('/api')) {
      if (!baseURL.endsWith('/')) {
        baseURL += '/api';
      } else {
        baseURL += 'api';
      }
    }

    this.client = axios.create({
      baseURL,
      timeout: config.timeout || 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Add request interceptor for auth
    this.client.interceptors.request.use((req) => {
      if (this.config.apiToken) {
        req.headers.Authorization = `Bearer ${this.config.apiToken}`;
      }
      return req;
    });

    // Add response interceptor for error handling
    this.client.interceptors.response.use(
      (response) => response,
      (error: AxiosError) => {
        if (error.response) {
          const data = error.response.data as { error?: string; message?: string };
          const message = data.error || data.message || 'Unknown API error';
          throw new BeehiveApiError(
            message,
            error.response.status,
            data,
            error.config?.url
          );
        }
        throw new BeehiveApiError(
          error.message || 'Network error',
          0,
          undefined,
          error.config?.url
        );
      }
    );
  }

  /**
   * Generic request method
   */
  private async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    data?: unknown,
    options?: RequestOptions
  ): Promise<T> {
    const config: AxiosRequestConfig = {
      method,
      url: path,
    };

    if (data !== undefined) {
      config.data = data;
    }

    if (options?.actorId) {
      config.headers = {
        ...config.headers,
        'X-Actor-ID': options.actorId,
      };
    }

    if (options?.timeout) {
      config.timeout = options.timeout;
    }

    if (options?.signal) {
      config.signal = options.signal;
    }

    const response = await this.client.request(config);
    const apiResponse = response.data as ApiResponse<T>;

    if (!apiResponse.success) {
      throw new BeehiveApiError(
        apiResponse.error || 'Request failed',
        response.status,
        apiResponse,
        path
      );
    }

    return apiResponse.data as T;
  }

  // ============================================================================
  // HEALTH
  // ============================================================================

  async getHealth(): Promise<HealthResponse> {
    return this.request<HealthResponse>('GET', '/health');
  }

  async getHealthExtended(): Promise<HealthResponse> {
    return this.request<HealthResponse>('GET', '/health');
  }

  // ============================================================================
  // ORGANIZATIONS
  // ============================================================================

  async createOrganization(
    request: CreateOrganizationRequest,
    options?: RequestOptions
  ): Promise<OrganizationResponse> {
    return this.request<OrganizationResponse>('POST', '/organizations', request, options);
  }

  async listOrganizations(
    limit?: number,
    offset?: number
  ): Promise<PaginatedResponse<OrganizationResponse>> {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set('limit', limit.toString());
    if (offset !== undefined) params.set('offset', offset.toString());
    
    return this.request<PaginatedResponse<OrganizationResponse>>(
      'GET',
      `/organizations?${params.toString()}`
    );
  }

  async getOrganization(id: string): Promise<OrganizationResponse> {
    return this.request<OrganizationResponse>('GET', `/organizations/${id}`);
  }

  // ============================================================================
  // ACTORS
  // ============================================================================

  async createActor(
    request: CreateActorRequest,
    options?: RequestOptions
  ): Promise<ActorResponse> {
    return this.request<ActorResponse>('POST', '/actors', request, options);
  }

  async listActors(
    limit?: number,
    offset?: number,
    type?: 'human' | 'agent'
  ): Promise<PaginatedResponse<ActorResponse>> {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set('limit', limit.toString());
    if (offset !== undefined) params.set('offset', offset.toString());
    if (type) params.set('type', type);
    
    return this.request<PaginatedResponse<ActorResponse>>(
      'GET',
      `/actors?${params.toString()}`
    );
  }

  async getActor(id: string): Promise<ActorResponse> {
    return this.request<ActorResponse>('GET', `/actors/${id}`);
  }

  async updateActorTrust(
    id: string,
    request: UpdateActorTrustRequest,
    options?: RequestOptions
  ): Promise<ActorResponse> {
    return this.request<ActorResponse>('PATCH', `/actors/${id}/trust`, request, options);
  }

  async grantPromotionAuthority(
    id: string,
    options?: RequestOptions
  ): Promise<ActorResponse> {
    return this.request<ActorResponse>('PATCH', `/actors/${id}/promotion-authority`, {}, options);
  }

  // ============================================================================
  // REPOSITORIES
  // ============================================================================

  async createRepository(
    request: CreateRepositoryRequest,
    options?: RequestOptions
  ): Promise<RepositoryResponse> {
    return this.request<RepositoryResponse>('POST', '/repositories', request, options);
  }

  async listRepositories(
    limit?: number,
    offset?: number,
    organizationId?: string,
    repoType?: 'baseline' | 'candidate'
  ): Promise<PaginatedResponse<RepositoryResponse>> {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set('limit', limit.toString());
    if (offset !== undefined) params.set('offset', offset.toString());
    if (organizationId) params.set('organizationId', organizationId);
    if (repoType) params.set('repoType', repoType);
    
    return this.request<PaginatedResponse<RepositoryResponse>>(
      'GET',
      `/repositories?${params.toString()}`
    );
  }

  async getRepository(id: string): Promise<RepositoryResponse> {
    return this.request<RepositoryResponse>('GET', `/repositories/${id}`);
  }

  // ============================================================================
  // SPECS
  // ============================================================================

  async createSpec(
    request: CreateSpecRequest,
    options?: RequestOptions
  ): Promise<SpecResponse> {
    // Handle contract as file path
    const processedRequest = { ...request };
    if (typeof processedRequest.contract === 'string' && processedRequest.contract.startsWith('@')) {
      // This would be handled by the caller
    }
    
    return this.request<SpecResponse>('POST', '/specs', processedRequest, options);
  }

  async listSpecs(
    limit?: number,
    offset?: number,
    organizationId?: string,
    stage?: 'draft' | 'proposed' | 'active' | 'deprecated' | 'archived'
  ): Promise<PaginatedResponse<SpecResponse>> {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set('limit', limit.toString());
    if (offset !== undefined) params.set('offset', offset.toString());
    if (organizationId) params.set('organizationId', organizationId);
    if (stage) params.set('stage', stage);
    
    return this.request<PaginatedResponse<SpecResponse>>(
      'GET',
      `/specs?${params.toString()}`
    );
  }

  async getSpec(id: string): Promise<SpecResponse> {
    return this.request<SpecResponse>('GET', `/specs/${id}`);
  }

  async updateSpecStage(
    id: string,
    request: UpdateSpecStageRequest,
    options?: RequestOptions
  ): Promise<SpecResponse> {
    return this.request<SpecResponse>('PATCH', `/specs/${id}/stage`, request, options);
  }

  // ============================================================================
  // CANDIDATES
  // ============================================================================

  async createCandidate(
    request: CreateCandidateRequest,
    options?: RequestOptions
  ): Promise<CandidateResponse> {
    return this.request<CandidateResponse>('POST', '/candidates', request, options);
  }

  async listCandidates(
    limit?: number,
    offset?: number,
    specId?: string,
    agentId?: string,
    stage?: string
  ): Promise<PaginatedResponse<CandidateResponse>> {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set('limit', limit.toString());
    if (offset !== undefined) params.set('offset', offset.toString());
    if (specId) params.set('specId', specId);
    if (agentId) params.set('agentId', agentId);
    if (stage) params.set('stage', stage);
    
    return this.request<PaginatedResponse<CandidateResponse>>(
      'GET',
      `/candidates?${params.toString()}`
    );
  }

  async getCandidate(id: string): Promise<CandidateResponse> {
    return this.request<CandidateResponse>('GET', `/candidates/${id}`);
  }

  async updateCandidateStage(
    id: string,
    request: UpdateCandidateStageRequest,
    options?: RequestOptions
  ): Promise<CandidateResponse> {
    return this.request<CandidateResponse>('PATCH', `/candidates/${id}/stage`, request, options);
  }

  async claimSpec(
    specId: string,
    request?: ClaimSpecRequest,
    options?: RequestOptions
  ): Promise<ClaimSpecResponse> {
    return this.request<ClaimSpecResponse>('POST', `/specs/${specId}/claim`, request, options);
  }

  async executeCandidate(
    candidateId: string,
    sandboxRunnerUrl?: string,
    options?: RequestOptions
  ): Promise<CandidateResponse> {
    return this.request<CandidateResponse>(
      'POST',
      `/candidates/${candidateId}/execute`,
      { sandboxRunnerUrl },
      options
    );
  }

  // ============================================================================
  // GATE VERDICTS
  // ============================================================================

  async createGateVerdict(
    request: CreateGateVerdictRequest,
    options?: RequestOptions
  ): Promise<GateVerdictResponse> {
    return this.request<GateVerdictResponse>('POST', '/gate-verdicts', request, options);
  }

  async listGateVerdicts(
    limit?: number,
    offset?: number,
    candidateId?: string,
    gate?: string,
    status?: 'pass' | 'fail' | 'pending'
  ): Promise<PaginatedResponse<GateVerdictResponse>> {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set('limit', limit.toString());
    if (offset !== undefined) params.set('offset', offset.toString());
    if (candidateId) params.set('candidateId', candidateId);
    if (gate) params.set('gate', gate);
    if (status) params.set('status', status);
    
    return this.request<PaginatedResponse<GateVerdictResponse>>(
      'GET',
      `/gate-verdicts?${params.toString()}`
    );
  }

  async getGateVerdict(id: string): Promise<GateVerdictResponse> {
    return this.request<GateVerdictResponse>('GET', `/gate-verdicts/${id}`);
  }

  async getGateVerdictsForCandidate(candidateId: string): Promise<GateVerdictResponse[]> {
    return this.request<GateVerdictResponse[]>('GET', `/candidates/${candidateId}/gate-verdicts`);
  }

  async runPreMergeGate(
    candidateId: string,
    options?: RequestOptions
  ): Promise<GateVerdictResponse> {
    return this.request<GateVerdictResponse>('POST', `/candidates/${candidateId}/gate/pre-merge`, {}, options);
  }

  // ============================================================================
  // TRIALS
  // ============================================================================

  async createTrial(
    request: CreateTrialRequest,
    options?: RequestOptions
  ): Promise<TrialResponse> {
    return this.request<TrialResponse>('POST', '/trials', request, options);
  }

  async listTrials(
    limit?: number,
    offset?: number,
    specId?: string,
    stage?: string
  ): Promise<PaginatedResponse<TrialResponse>> {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set('limit', limit.toString());
    if (offset !== undefined) params.set('offset', offset.toString());
    if (specId) params.set('specId', specId);
    if (stage) params.set('stage', stage);
    
    return this.request<PaginatedResponse<TrialResponse>>(
      'GET',
      `/trials?${params.toString()}`
    );
  }

  async getTrial(id: string): Promise<TrialResponse> {
    return this.request<TrialResponse>('GET', `/trials/${id}`);
  }

  async decideTrial(
    trialId: string,
    request: DecideTrialRequest,
    options?: RequestOptions
  ): Promise<TrialResponse> {
    return this.request<TrialResponse>('POST', `/trials/${trialId}/decide`, request, options);
  }

  // ============================================================================
  // PROMOTIONS
  // ============================================================================

  async createPromotion(
    request: CreatePromotionRequest,
    options?: RequestOptions
  ): Promise<PromotionResponse> {
    return this.request<PromotionResponse>('POST', '/promotions', request, options);
  }

  async listPromotions(
    limit?: number,
    offset?: number,
    candidateId?: string
  ): Promise<PaginatedResponse<PromotionResponse>> {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set('limit', limit.toString());
    if (offset !== undefined) params.set('offset', offset.toString());
    if (candidateId) params.set('candidateId', candidateId);
    
    return this.request<PaginatedResponse<PromotionResponse>>(
      'GET',
      `/promotions?${params.toString()}`
    );
  }



  // ============================================================================
  // ISSUES
  // ============================================================================

  async createIssue(
    request: CreateIssueRequest,
    options?: RequestOptions
  ): Promise<IssueResponse> {
    return this.request<IssueResponse>('POST', '/issues', request, options);
  }

  async listIssues(
    limit?: number,
    offset?: number,
    repositoryId?: string,
    stage?: string,
    status?: string
  ): Promise<PaginatedResponse<IssueResponse>> {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set('limit', limit.toString());
    if (offset !== undefined) params.set('offset', offset.toString());
    if (repositoryId) params.set('repositoryId', repositoryId);
    if (stage) params.set('stage', stage);
    if (status) params.set('status', status);
    
    return this.request<PaginatedResponse<IssueResponse>>(
      'GET',
      `/issues?${params.toString()}`
    );
  }

  async getIssue(id: string): Promise<IssueResponse> {
    return this.request<IssueResponse>('GET', `/issues/${id}`);
  }

  // ============================================================================
  // ENTITY HISTORY
  // ============================================================================

  async getEntityHistory(
    entityType: EntityType,
    entityId: string
  ): Promise<EntityHistoryResponse> {
    return this.request<EntityHistoryResponse>(
      'GET',
      `/entities/${entityType}/${entityId}/history`
    );
  }

  // ============================================================================
  // DEBUG ENDPOINTS (Custom for CLI)
  // Note: These may need to be added to the API worker
  // ============================================================================

  /**
   * Get full state dump from Spec DO
   * This is a debug endpoint that aggregates all entities
   */
  async getStateDump(options?: RequestOptions): Promise<StateDumpResponse> {
    return this.request<StateDumpResponse>('GET', '/debug/state-dump', undefined, options);
  }

  /**
   * Get queue status
   */
  async getQueueStatus(queueName: string, options?: RequestOptions): Promise<QueueStatus> {
    return this.request<QueueStatus>('GET', `/debug/queues/${queueName}/status`, undefined, options);
  }

  /**
   * List all queues
   */
  async listQueues(options?: RequestOptions): Promise<QueueStatus[]> {
    return this.request<QueueStatus[]>('GET', '/debug/queues', undefined, options);
  }

  /**
   * Get Artifacts status
   */
  async getArtifactsStatus(options?: RequestOptions): Promise<ArtifactsStatus> {
    return this.request<ArtifactsStatus>('GET', '/debug/artifacts/status', undefined, options);
  }

  /**
   * List Artifacts repositories
   */
  async listArtifactsRepos(options?: RequestOptions): Promise<{ repositories: unknown[] }> {
    return this.request<{ repositories: unknown[] }>('GET', '/debug/artifacts/repos', undefined, options);
  }

  /**
   * Test claim workflow
   */
  async testClaimWorkflow(
    specId: string,
    dryRun?: boolean,
    options?: RequestOptions
  ): Promise<ClaimSpecResponse> {
    return this.request<ClaimSpecResponse>(
      'POST',
      `/debug/claim-test/${specId}`,
      { dryRun },
      options
    );
  }

  // ============================================================================
  // RAW REQUEST (for extensibility)
  // ============================================================================

  /**
   * Make a raw request to the API
   */
  async rawRequest<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    data?: unknown,
    options?: RequestOptions
  ): Promise<T> {
    return this.request<T>(method, path, data, options);
  }

  /**
   * Check if the client is authenticated
   */
  get isAuthenticated(): boolean {
    return !!this.config.apiToken;
  }

  /**
   * Get the current API URL
   */
  get apiUrl(): string {
    return this.client.defaults.baseURL || '';
  }

  /**
   * Update the API token
   */
  updateToken(token: string): void {
    this.config.apiToken = token;
    const headers = this.client.defaults.headers as Record<string, string>;
    headers.Authorization = token ? `Bearer ${token}` : '';
  }

  /**
   * Update the API URL
   */
  updateUrl(url: string): void {
    this.config.apiUrl = url;
    this.client.defaults.baseURL = url.endsWith('/api') ? url : `${url}/api`;
  }
}

/**
 * Create a BeehiveClient instance
 */
export function createClient(config: BeehiveConfig): BeehiveClient {
  return new BeehiveClient(config);
}
