/**
 * Beehive API Service Layer
 * 
 * Centralized API client for fetching data from the Beehive backend.
 */

import type {
  Trial,
  Candidate,
  Spec,
  Actor,
  GateVerdict,
  ApiResponse,
  PaginatedResponse,
  TrialFilter,
  CandidateFilter,
  TrialComparison,
} from '../types';

const API_BASE = import.meta.env.VITE_API_BASE || '/api';

// ============================================================================
// TRIALS
// ============================================================================

export async function fetchTrials(filter?: TrialFilter, page: number = 1, pageSize: number = 20): Promise<PaginatedResponse<Trial>> {
  const params = new URLSearchParams({
    page: page.toString(),
    pageSize: pageSize.toString(),
  });
  
  if (filter) {
    if (filter.specId) params.set('specId', filter.specId);
    if (filter.stage) params.set('stage', filter.stage);
    if (filter.candidateId) params.set('candidateId', filter.candidateId);
    if (filter.decidedBy) params.set('decidedBy', filter.decidedBy);
  }
  
  const response = await fetch(`${API_BASE}/trials?${params.toString()}`);
  if (!response.ok) throw new Error('Failed to fetch trials');
  return response.json();
}

export async function fetchTrialById(trialId: string): Promise<ApiResponse<TrialComparison>> {
  const response = await fetch(`${API_BASE}/trials/${trialId}`);
  if (!response.ok) throw new Error('Failed to fetch trial');
  return response.json();
}

// ============================================================================
// CANDIDATES
// ============================================================================

export async function fetchCandidates(filter?: CandidateFilter, page: number = 1, pageSize: number = 20): Promise<PaginatedResponse<Candidate>> {
  const params = new URLSearchParams({
    page: page.toString(),
    pageSize: pageSize.toString(),
  });
  
  if (filter) {
    if (filter.specId) params.set('specId', filter.specId);
    if (filter.agentId) params.set('agentId', filter.agentId);
    if (filter.stage) params.set('stage', filter.stage);
  }
  
  const response = await fetch(`${API_BASE}/candidates?${params.toString()}`);
  if (!response.ok) throw new Error('Failed to fetch candidates');
  return response.json();
}

export async function fetchCandidateById(candidateId: string): Promise<ApiResponse<Candidate & { verdicts?: GateVerdict[]; spec?: Spec; actor?: Actor }>> {
  const response = await fetch(`${API_BASE}/candidates/${candidateId}`);
  if (!response.ok) throw new Error('Failed to fetch candidate');
  return response.json();
}

// ============================================================================
// SPECS
// ============================================================================

export async function fetchSpecs(page: number = 1, pageSize: number = 20): Promise<PaginatedResponse<Spec>> {
  const params = new URLSearchParams({
    page: page.toString(),
    pageSize: pageSize.toString(),
  });
  
  const response = await fetch(`${API_BASE}/specs?${params.toString()}`);
  if (!response.ok) throw new Error('Failed to fetch specs');
  return response.json();
}

export async function fetchSpecById(specId: string): Promise<ApiResponse<Spec>> {
  const response = await fetch(`${API_BASE}/specs/${specId}`);
  if (!response.ok) throw new Error('Failed to fetch spec');
  return response.json();
}

// ============================================================================
// ACTORS
// ============================================================================

export async function fetchActors(page: number = 1, pageSize: number = 20): Promise<PaginatedResponse<Actor>> {
  const params = new URLSearchParams({
    page: page.toString(),
    pageSize: pageSize.toString(),
  });
  
  const response = await fetch(`${API_BASE}/actors?${params.toString()}`);
  if (!response.ok) throw new Error('Failed to fetch actors');
  return response.json();
}

export async function fetchActorById(actorId: string): Promise<ApiResponse<Actor>> {
  const response = await fetch(`${API_BASE}/actors/${actorId}`);
  if (!response.ok) throw new Error('Failed to fetch actor');
  return response.json();
}

// ============================================================================
// GATE VERDICTS
// ============================================================================

export async function fetchGateVerdicts(candidateId: string): Promise<ApiResponse<GateVerdict[]>> {
  const response = await fetch(`${API_BASE}/candidates/${candidateId}/verdicts`);
  if (!response.ok) throw new Error('Failed to fetch gate verdicts');
  return response.json();
}

// ============================================================================
// HEALTH
// ============================================================================

export async function fetchHealth(): Promise<ApiResponse<{ status: string; timestamp: number }>> {
  const response = await fetch(`${API_BASE}/health`);
  if (!response.ok) throw new Error('Failed to fetch health');
  return response.json();
}
