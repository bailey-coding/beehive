---
category: feature
status: active
audience: human,agent
tags:
  - issue-creation
  - specs
---

# Issue Creation Technical Specification

**Status:** Draft  
**Owner:** @bailey  
**Created:** 2026-10-14  
**Parent:** ISSUE-CREATION-UX-DESIGN.md

---

## Overview

This document provides the **technical implementation details** for the issue creation UX design. It covers:

1. API endpoint specifications
2. Algorithm implementations
3. Database schema changes
4. Integration points

---

## API Endpoints

### 1. Similarity Check Endpoint

**Path:** `GET /api/issues/similar`

**Purpose:** Find issues similar to the one being created to prevent duplicates.

**Query Parameters:**
```typescript
interface SimilarIssuesQuery {
  repositoryId: string; // Required
  title?: string;      // Optional, but recommended
  description?: string; // Optional, but recommended
  limit?: number;      // Default: 5, Max: 10
  minSimilarity?: number; // Default: 60 (0-100)
}
```

**Response:**
```typescript
interface SimilarIssuesResponse {
  success: boolean;
  data: SimilarIssue[];
  timestamp: number;
}

interface SimilarIssue {
  id: string;
  number: number;
  title: string;
  repositoryId: string;
  similarityScore: number; // 0-100
  matchedTokens: string[]; // Top 5 matching tokens
  specId?: string;
  specName?: string;
  specStage?: string;
  status: 'open' | 'closed';
  stage: string;
  createdAt: number;
  url: string; // /app/issues/{id}
}
```

**Implementation Notes:**
- Uses cosine similarity on TF-IDF vectors
- Considers title, description, and repository
- Filters by same repository
- Caches results for 5 minutes
- Returns empty array if no matches above threshold

**Error Responses:**
- 400: repositoryId is required
- 404: repository not found

---

### 2. Spec Suggestions Endpoint

**Path:** `GET /api/specs/suggest`

**Purpose:** Find specs relevant to the issue being created.

**Query Parameters:**
```typescript
interface SpecSuggestionsQuery {
  repositoryId: string; // Required
  query: string;       // Required (title + description)
  limit?: number;      // Default: 5, Max: 10
  minConfidence?: number; // Default: 30 (0-100)
}
```

**Response:**
```typescript
interface SpecSuggestionsResponse {
  success: boolean;
  data: SpecMatch[];
  timestamp: number;
}

interface SpecMatch {
  spec: Spec;
  confidence: number; // 0-100
  matchReasons: string[];
  contractMatches: Array<{
    path: string;
    method: string;
    relevance: number; // 0-100
  }>;
  deltaSurfaceMatches: string[];
  suggestedRelationship: 'reports-bug' | 'requests-new' | 'requests-change';
}
```

**Implementation Notes:**
- Parses contract to extract endpoints
- Matches endpoints against query text
- Calculates confidence from multiple factors
- Sorts by confidence descending
- Includes relationship suggestion

**Error Responses:**
- 400: repositoryId and query are required
- 404: repository not found

---

### 3. Partial Spec Extraction Endpoint

**Path:** `POST /api/specs/extract`

**Purpose:** Extract partial spec information from issue text.

**Request Body:**
```typescript
interface ExtractSpecRequest {
  text: string;           // Issue description
  repositoryId: string;   // For context
  context?: {
    title?: string;
    labels?: string[];
  };
}
```

**Response:**
```typescript
interface ExtractSpecResponse {
  success: boolean;
  data: PartialContract;
  timestamp: number;
}

interface PartialContract {
  endpoints?: Array<{
    method: string;
    path: string;
    queryParams?: Record<string, { type: string; required?: boolean }>;
    requestBody?: Record<string, { type: string; required?: boolean }>;
    responseStatuses?: number[];
  }>;
  expectedBehaviors?: string[];
  extractedEntities: Array<{
    type: 'method' | 'path' | 'status_code' | 'param' | 'field';
    value: string;
    context: string;
  }>;
}
```

**Implementation Notes:**
- Uses regex patterns to extract HTTP methods, paths, status codes
- Identifies query parameters and body fields
- Groups by endpoint
- Returns confidence scores for each extraction
- Handles edge cases (ambiguous paths, etc.)

**Error Responses:**
- 400: text is required
- 400: text is too short (< 10 characters)

---

### 4. Spec Validation Endpoint

**Path:** `POST /api/specs/validate`

**Purpose:** Validate a spec before creation.

**Request Body:**
```typescript
interface ValidateSpecRequest {
  name?: string;
  description?: string;
  contract: string; // JSON string
  declaredDeltaSurface?: string | string[];
}
```

**Response:**
```typescript
interface ValidateSpecResponse {
  success: boolean;
  data: ValidationResult;
  timestamp: number;
}

interface ValidationResult {
  valid: boolean;
  errors: Array<{
    field: string;
    message: string;
    severity: 'error' | 'warning';
    location?: { line: number; column: number };
    suggestion?: string;
  }>;
  warnings: Array<{
    field: string;
    message: string;
    suggestion?: string;
  }>;
  suggestions: Array<{
    field: string;
    suggestion: string;
    autoFix?: string; // Pre-filled value
  }>;
}
```

**Validation Rules:**
```typescript
const SPEC_VALIDATION_RULES = {
  name: {
    required: true,
    minLength: 3,
    maxLength: 120,
    pattern: /^[a-zA-Z0-9_-]+$/,
    message: 'Name must be 3-120 characters, alphanumeric with hyphens/underscores'
  },
  contract: {
    required: true,
    validate: (contract: unknown) => {
      if (typeof contract !== 'string') return { valid: false, error: 'Contract must be a string' };
      try {
        const parsed = JSON.parse(contract);
        if (!parsed.endpoints || !Array.isArray(parsed.endpoints)) {
          return { valid: false, error: 'Contract must have endpoints array' };
        }
        for (const ep of parsed.endpoints) {
          if (!ep.method || !ep.path) {
            return { valid: false, error: 'Each endpoint must have method and path' };
          }
          if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(ep.method.toUpperCase())) {
            return { valid: false, error: `Invalid method: ${ep.method}` };
          }
        }
        return { valid: true };
      } catch (e) {
        return { valid: false, error: `Invalid JSON: ${e.message}` };
      }
    }
  },
  declaredDeltaSurface: {
    required: true,
    validate: (surface: unknown) => {
      if (!surface) return { valid: false, error: 'Delta surface is required' };
      if (typeof surface === 'string') {
        if (surface.trim() === '') return { valid: false, error: 'Delta surface cannot be empty' };
      } else if (Array.isArray(surface)) {
        if (surface.length === 0) return { valid: false, error: 'Delta surface must have at least one item' };
      }
      return { valid: true };
    }
  }
};
```

**Error Responses:**
- 400: contract is required

---

### 5. Enhanced Issue Creation Endpoint

**Path:** `POST /api/issues` (enhanced)

**Request Body:**
```typescript
interface CreateIssueWithSpecRequest extends Omit<CreateIssueRequest, 'body'> {
  // Existing fields
  number?: number; // Auto-generated if not provided
  repositoryId: string;
  title: string;
  body?: string;
  labels?: string[];
  createdBy?: string;
  
  // New fields for spec integration
  issueSpecLinks?: Array<{
    specId: string;
    relationship: 'requests-new' | 'requests-change' | 'reports-bug';
  }>;
  
  // For creating new spec alongside issue
  createSpec?: Omit<CreateSpecRequest, 'createdBy' | 'createdAt' | 'id'> & {
    _source?: 'issue_creation';
    _issueId?: string; // Will be set by server
  };
  
  // Flow control
  skipSimilarityCheck?: boolean; // For agents/programmatic use
  skipSpecSuggestions?: boolean; // For agents/programmatic use
  autoLinkToSpec?: boolean; // Auto-link to best matching spec
  similarityOverride?: boolean; // User confirmed not a duplicate
  suggestedSpecId?: string; // Pre-selected spec from suggestions
}
```

**Response:**
```typescript
interface CreateIssueWithSpecResponse {
  success: boolean;
  data: {
    issue: Issue;
    createdSpec?: Spec; // If new spec was created
    createdLinks: IssueSpecLink[];
    duplicateWarning?: {
      similarIssues: SimilarIssue[];
      wasMarkedDuplicate: boolean;
    };
    suggestions?: {
      specs: SpecMatch[]; // Spec suggestions that were calculated
      partialSpec?: PartialContract; // Partial spec that was extracted
    };
  };
  timestamp: number;
}
```

**Implementation Notes:**
- If `createSpec` is provided, create spec first, then create issue
- If `issueSpecLinks` is provided, create links after issue creation
- If `autoLinkToSpec` is true, find best match and auto-link
- If `skipSimilarityCheck` is false (default), check for duplicates
- If duplicates found with score >= 90, return warning (but still create)
- Set issue stage based on spec linkage:
  - If linked to active spec: `implementing`
  - If linked to other spec: `spec_defined`
  - If new spec created: `spec_defining`
  - Otherwise: `reported`

**Error Responses:**
- 400: repositoryId and title are required
- 400: createSpec has validation errors
- 400: issueSpecLinks references non-existent spec
- 404: repository not found

---

## Algorithm Implementations

### Similarity Calculation

**File:** `workers/shared/similarity.ts`

```typescript
import { Tokenizer } from './tokenizer';

export class IssueSimilarityCalculator {
  private tokenizer: Tokenizer;
  private stopWords: Set<string>;
  
  constructor() {
    this.tokenizer = new Tokenizer();
    this.stopWords = new Set(['the', 'a', 'an', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or']);
  }
  
  async calculateSimilarity(
    issue1: { title: string; description?: string },
    issue2: { title: string; description?: string }
  ): Promise<number> {
    const text1 = `${issue1.title} ${issue1.description || ''}`;
    const text2 = `${issue2.title} ${issue2.description || ''}`;
    
    // Tokenize and vectorize
    const vec1 = await this.vectorize(text1);
    const vec2 = await this.vectorize(text2);
    
    // Cosine similarity
    const similarity = this.cosineSimilarity(vec1, vec2);
    
    return similarity * 100; // Convert to 0-100 scale
  }
  
  private async vectorize(text: string): Promise<Record<string, number>> {
    const tokens = this.tokenizer.tokenize(text.toLowerCase())
      .filter(t => !this.stopWords.has(t));
    
    const vector: Record<string, number> = {};
    for (const token of tokens) {
      vector[token] = (vector[token] || 0) + 1;
    }
    
    return vector;
  }
  
  private cosineSimilarity(vec1: Record<string, number>, vec2: Record<string, number>): number {
    // Dot product
    let dotProduct = 0;
    for (const key of Object.keys(vec1)) {
      if (key in vec2) {
        dotProduct += vec1[key] * vec2[key];
      }
    }
    
    // Magnitude
    const mag1 = Math.sqrt(Object.values(vec1).reduce((sum, v) => sum + v * v, 0));
    const mag2 = Math.sqrt(Object.values(vec2).reduce((sum, v) => sum + v * v, 0));
    
    if (mag1 === 0 || mag2 === 0) return 0;
    
    return dotProduct / (mag1 * mag2);
  }
  
  async findSimilarIssues(
    target: { title: string; description?: string; repositoryId: string },
    candidates: Issue[],
    limit: number = 5
  ): Promise<SimilarIssue[]> {
    const results: Array<{ issue: Issue; score: number }> = [];
    
    for (const candidate of candidates) {
      if (candidate.repositoryId !== target.repositoryId) continue;
      if (candidate.id === target.id) continue; // Skip self
      
      const score = await this.calculateSimilarity(
        { title: target.title, description: target.description },
        { title: candidate.title, description: candidate.body }
      );
      
      results.push({ issue: candidate, score });
    }
    
    // Sort by score descending
    results.sort((a, b) => b.score - a.score);
    
    // Take top N
    const topResults = results.slice(0, limit);
    
    // Convert to response format
    return topResults.map(({ issue, score }) => ({
      id: issue.id,
      number: issue.number,
      title: issue.title,
      repositoryId: issue.repositoryId,
      similarityScore: Math.round(score),
      matchedTokens: this.getMatchedTokens(target, issue),
      specId: issue.specId, // If directly linked
      specName: issue.spec?.name, // Would need to look up
      specStage: issue.spec?.stage,
      status: issue.status,
      stage: issue.stage,
      createdAt: issue.createdAt,
      url: `/app/issues/${issue.id}`
    }));
  }
}
```

### Spec Matching Algorithm

**File:** `workers/shared/spec-matcher.ts`

```typescript
import { Spec } from '../schemas';

export class SpecMatcher {
  async matchSpecsToQuery(
    query: string,
    specs: Spec[],
    repositoryId?: string
  ): Promise<SpecMatch[]> {
    const results: SpecMatch[] = [];
    
    for (const spec of specs) {
      // Filter by repository if specified
      if (repositoryId && spec.repositoryId !== repositoryId) continue;
      
      const confidence = await this.calculateMatchConfidence(spec, query);
      
      if (confidence >= 30) { // Only include reasonably relevant
        const relationship = this.suggestRelationship(spec, query);
        results.push({
          spec,
          confidence: Math.round(confidence),
          matchReasons: this.getMatchReasons(spec, query),
          contractMatches: this.getContractMatches(spec, query),
          deltaSurfaceMatches: this.getDeltaSurfaceMatches(spec, query),
          suggestedRelationship: relationship
        });
      }
    }
    
    // Sort by confidence descending
    results.sort((a, b) => b.confidence - a.confidence);
    
    return results;
  }
  
  private async calculateMatchConfidence(spec: Spec, query: string): Promise<number> {
    const text = query.toLowerCase();
    
    // Path matching (30%)
    const contract = JSON.parse(spec.contract);
    const endpoints = contract.endpoints || [];
    const pathMatches = endpoints.filter((ep: any) => 
      text.includes(ep.path.toLowerCase())
    );
    const pathScore = (pathMatches.length / endpoints.length) * 30;
    
    // Delta surface matching (25%)
    const deltaSurface = Array.isArray(spec.declaredDeltaSurface) 
      ? spec.declaredDeltaSurface 
      : [spec.declaredDeltaSurface];
    const surfaceMatches = deltaSurface.filter(d => 
      typeof d === 'string' && text.includes(d.toLowerCase())
    );
    const surfaceScore = (surfaceMatches.length / deltaSurface.length) * 25;
    
    // Keyword matching (25%)
    const nameMatch = spec.name.toLowerCase().includes(text) ? 15 : 0;
    const descMatch = spec.description?.toLowerCase().includes(text) ? 10 : 0;
    const keywordScore = nameMatch + descMatch;
    
    // Stage bonus (20%)
    const stageBonus = spec.stage === 'active' ? 20 
      : spec.stage === 'proposed' ? 10 
      : 0;
    
    return pathScore + surfaceScore + keywordScore + stageBonus;
  }
  
  private suggestRelationship(spec: Spec, query: string): 'reports-bug' | 'requests-new' | 'requests-change' {
    const text = query.toLowerCase();
    
    // Check for bug reporting keywords
    const bugKeywords = ['bug', 'error', 'fail', 'broken', 'not working', 'wrong', 'violates', 'contradicts'];
    if (bugKeywords.some(kw => text.includes(kw))) {
      return 'reports-bug';
    }
    
    // Check for new feature keywords
    const newKeywords = ['add', 'new', 'create', 'implement', 'feature', 'support', 'enable'];
    if (newKeywords.some(kw => text.includes(kw))) {
      return 'requests-new';
    }
    
    // Check for change keywords
    const changeKeywords = ['change', 'update', 'modify', 'improve', 'enhance', 'refactor'];
    if (changeKeywords.some(kw => text.includes(kw))) {
      return 'requests-change';
    }
    
    // Default
    return 'reports-bug';
  }
}
```

### Partial Spec Extraction

**File:** `workers/shared/spec-extractor.ts`

```typescript
export class SpecExtractor {
  extractPartialSpec(text: string): PartialContract {
    const partial: PartialContract = {
      endpoints: [],
      expectedBehaviors: []
    };
    
    const extractedEntities: Array<{ type: string; value: string; context: string }> = [];
    
    // Extract HTTP methods and paths
    const endpointPattern = /(?:^|\s)(GET|POST|PUT|PATCH|DELETE|get|post|put|patch|delete)\s+(\/\S+)/gi;
    const endpointMatches = [...text.matchAll(endpointPattern)];
    
    for (const match of endpointMatches) {
      const method = match[1].toUpperCase();
      const path = match[2];
      
      extractedEntities.push({
        type: 'method',
        value: method,
        context: `Endpoint method at path ${path}`
      });
      extractedEntities.push({
        type: 'path',
        value: path,
        context: `Endpoint path for ${method}`
      });
      
      // Check if this endpoint already exists
      const existingEp = partial.endpoints?.find(ep => ep.path === path);
      if (!existingEp) {
        partial.endpoints?.push({
          method,
          path,
          queryParams: {},
          requestBody: {},
          responseStatuses: []
        });
      }
    }
    
    // Extract query parameters
    const paramPattern = /(?:query|param|parameter|param:?)\s+[`"]([^`"]+)[`"]/gi;
    const paramMatches = [...text.matchAll(paramPattern)];
    
    for (const match of paramMatches) {
      const paramName = match[1];
      extractedEntities.push({
        type: 'param',
        value: paramName,
        context: 'Query parameter'
      });
      
      // Add to all endpoints that might have params
      for (const ep of partial.endpoints || []) {
        ep.queryParams ||= {};
        if (!(paramName in ep.queryParams)) {
          ep.queryParams[paramName] = { type: 'string', required: false };
        }
      }
    }
    
    // Extract HTTP status codes
    const statusPattern = /(?:status|code|returns?|should\s+be\s+|is\s+|was\s+)\s+(\d{3})/gi;
    const statusMatches = [...text.matchAll(statusPattern)];
    
    for (const match of statusMatches) {
      const status = parseInt(match[1]);
      if (status >= 100 && status <= 599) {
        extractedEntities.push({
          type: 'status_code',
          value: status.toString(),
          context: 'HTTP status code'
        });
        
        // Add to all endpoints
        for (const ep of partial.endpoints || []) {
          ep.responseStatuses ||= [];
          if (!ep.responseStatuses.includes(status)) {
            ep.responseStatuses.push(status);
          }
        }
      }
    }
    
    // Extract field names from JSON-like text
    const fieldPattern = /"([a-zA-Z_][a-zA-Z0-9_]*)"\s*:/g;
    const fieldMatches = [...text.matchAll(fieldPattern)];
    
    for (const match of fieldMatches) {
      const fieldName = match[1];
      extractedEntities.push({
        type: 'field',
        value: fieldName,
        context: 'JSON field'
      });
    }
    
    partial.extractedEntities = extractedEntities;
    
    return partial;
  }
}
```

---

## Database Schema Changes

### New Table: issue_creation_suggestions

**File:** `workers/spec-do/schema.sql` (add to existing schema)

```sql
-- For tracking user/agent interactions with suggestions
CREATE TABLE IF NOT EXISTS issue_creation_suggestions (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL,
  suggestion_type TEXT NOT NULL CHECK(suggestion_type IN ('spec_match', 'duplicate', 'partial_spec', 'intent')),
  suggested_id TEXT,
  suggested_data TEXT,
  confidence INTEGER NOT NULL CHECK(confidence >= 0 AND confidence <= 100),
  accepted BOOLEAN,
  accepted_at INTEGER,
  overridden_by TEXT,
  overridden_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (issue_id) REFERENCES issues(id),
  FOREIGN KEY (suggested_id) REFERENCES specs(id),
  FOREIGN KEY (overridden_by) REFERENCES actors(id)
);

CREATE INDEX IF NOT EXISTS idx_issue_creation_suggestions_issue 
  ON issue_creation_suggestions(issue_id);

CREATE INDEX IF NOT EXISTS idx_issue_creation_suggestions_type 
  ON issue_creation_suggestions(suggestion_type);

CREATE INDEX IF NOT EXISTS idx_issue_creation_suggestions_accepted 
  ON issue_creation_suggestions(accepted, issue_id);
```

### Modified Table: issues

Add new columns to track creation context:

```sql
ALTER TABLE issues ADD COLUMN created_from_spec_id TEXT;
ALTER TABLE issues ADD COLUMN spec_link_confidence INTEGER;
ALTER TABLE issues ADD COLUMN duplicate_of TEXT;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_issues_created_from_spec ON issues(created_from_spec_id);
CREATE INDEX IF NOT EXISTS idx_issues_duplicate_of ON issues(duplicate_of);
```

---

## Spec DO Integration

**File:** `workers/spec-do/index.ts`

Add new methods to SpecDO class:

```typescript
// In SpecDO class
async findSimilarIssues(
  repositoryId: string,
  title: string,
  description?: string,
  limit: number = 5
): Promise<SimilarIssue[]> {
  // Get all issues for repository
  const issues = await this.getIssuesByRepository(repositoryId);
  
  // Calculate similarity
  const calculator = new IssueSimilarityCalculator();
  return calculator.findSimilarIssues(
    { title, description, repositoryId },
    issues,
    limit
  );
}

async suggestSpecsForIssue(
  repositoryId: string,
  query: string,
  limit: number = 5
): Promise<SpecMatch[]> {
  // Get specs that might be relevant
  const specs = await this.getSpecsByRepository(repositoryId);
  
  const matcher = new SpecMatcher();
  return matcher.matchSpecsToQuery(query, specs, repositoryId);
}

async extractPartialSpec(text: string): Promise<PartialContract> {
  const extractor = new SpecExtractor();
  return extractor.extractPartialSpec(text);
}

async validateSpec(spec: {
  name?: string;
  description?: string;
  contract: string;
  declaredDeltaSurface?: string | string[];
}): Promise<ValidationResult> {
  const validator = new SpecValidator();
  return validator.validate(spec);
}

async createIssueWithSpec(
  issueData: CreateIssueWithSpecRequest,
  actorId: string
): Promise<CreateIssueWithSpecResponse> {
  const tx = this.storage.beginTransaction();
  
  try {
    // Handle spec creation first if needed
    let createdSpec: Spec | undefined;
    if (issueData.createSpec) {
      createdSpec = await this.createSpec({
        ...issueData.createSpec,
        createdBy: actorId,
        createdAt: Date.now()
      }, actorId);
      
      // Record suggestion tracking
      if (issueData.suggestedSpecId) {
        await this.recordSuggestion({
          issue_id: '', // Will be set after issue creation
          suggestion_type: 'partial_spec',
          suggested_id: createdSpec.id,
          confidence: 100, // Created from partial
          accepted: true,
          created_at: Date.now()
        });
      }
    }
    
    // Create the issue
    const issue = await this.createIssue({
      ...issueData,
      createdBy: actorId,
      createdAt: Date.now(),
      created_from_spec_id: createdSpec?.id || issueData.createSpec?.name,
      number: issueData.number || await this.generateNextIssueNumber(issueData.repositoryId)
    }, actorId);
    
    // Update suggestion with issue ID
    if (createdSpec && issueData.suggestedSpecId) {
      await this.updateSuggestionIssueId(
        issue.id,
        createdSpec.id
      );
    }
    
    // Handle spec links
    const createdLinks: IssueSpecLink[] = [];
    if (issueData.issueSpecLinks?.length) {
      for (const link of issueData.issueSpecLinks) {
        const createdLink = await this.createIssueSpecLink({
          issueId: issue.id,
          specId: link.specId,
          relationship: link.relationship,
          createdAt: Date.now()
        }, actorId);
        createdLinks.push(createdLink);
        
        // Record suggestion
        await this.recordSuggestion({
          issue_id: issue.id,
          suggestion_type: 'spec_match',
          suggested_id: link.specId,
          confidence: 100, // Explicitly linked
          accepted: true,
          created_at: Date.now()
        });
      }
    }
    
    // Handle auto-linking
    if (issueData.autoLinkToSpec && !issueData.issueSpecLinks?.length) {
      const suggestions = await this.suggestSpecsForIssue(
        issueData.repositoryId,
        `${issueData.title} ${issueData.body || ''}`
      );
      
      if (suggestions.length > 0) {
        const best = suggestions[0];
        const link = await this.createIssueSpecLink({
          issueId: issue.id,
          specId: best.spec.id,
          relationship: best.suggestedRelationship,
          createdAt: Date.now()
        }, actorId);
        createdLinks.push(link);
        
        await this.recordSuggestion({
          issue_id: issue.id,
          suggestion_type: 'spec_match',
          suggested_id: best.spec.id,
          confidence: best.confidence,
          accepted: true,
          created_at: Date.now()
        });
      }
    }
    
    // Check for duplicates if not skipped
    if (!issueData.skipSimilarityCheck) {
      const similarIssues = await this.findSimilarIssues(
        issueData.repositoryId,
        issueData.title,
        issueData.body
      );
      
      if (similarIssues.length > 0 && similarIssues[0].similarityScore >= 90) {
        // Mark as potential duplicate
        await this.updateIssue(issue.id, {
          duplicateOf: similarIssues[0].id
        }, actorId);
      }
    }
    
    // Set issue stage based on spec linkage
    let stage = 'reported';
    if (createdLinks.length > 0) {
      // Check if any linked spec is active
      const specs = await this.getSpecsByIds(createdLinks.map(l => l.specId));
      const activeSpecs = specs.filter(s => s.stage === 'active');
      
      if (activeSpecs.length > 0) {
        stage = 'implementing';
      } else if (specs.length > 0) {
        stage = 'spec_defined';
      }
    } else if (createdSpec) {
      stage = 'spec_defining';
    }
    
    await this.updateIssue(issue.id, { stage }, actorId);
    
    tx.commit();
    
    return {
      issue,
      createdSpec,
      createdLinks,
      duplicateWarning: createdLinks.length > 0 ? undefined : {
        similarIssues,
        wasMarkedDuplicate: false
      }
    };
  } catch (error) {
    tx.rollback();
    throw error;
  }
}

async recordSuggestion(suggestion: {
  issue_id: string;
  suggestion_type: string;
  suggested_id?: string;
  suggested_data?: string;
  confidence: number;
  accepted: boolean;
}): Promise<void> {
  await this.storage.sql`
    INSERT INTO issue_creation_suggestions 
    (id, issue_id, suggestion_type, suggested_id, suggested_data, confidence, accepted, created_at)
    VALUES (${this.generateId()}, ${suggestion.issue_id}, ${suggestion.suggestion_type}, 
            ${suggestion.suggested_id || null}, ${suggestion.suggested_data || null}, 
            ${suggestion.confidence}, ${suggestion.accepted}, ${Date.now()})
  `;
}
```

---

## Frontend Integration

**File:** `workers/api/ui.ts` (enhancements)

Add new route handler:

```typescript
// New route for issue creation page
if (path === '/app/issues/new' && method === 'GET') {
  return issueCreationPage(url, session, stub, doReader);
}

// Enhanced issue creation handler
async function handleCreateIssue(
  request: Request,
  stub: DurableObjectStub
): Promise<Response> {
  const body: CreateIssueWithSpecRequest = await request.json();
  const actorId = request.headers.get('X-Actor-ID') || 'unknown';
  
  // Enhanced: handle new fields
  const response = await sendToSpecDo(
    stub,
    '/api/issues',
    'POST',
    body,
    actorId
  );
  
  return response;
}
```

---

## CLI Integration

**File:** `cli/src/commands/issue.ts` (enhancements)

```typescript
import { Command } from 'commander';
import { CliState, GlobalOptions } from '../index';
import { printOutput, formatSuccess, formatError } from '../utils/output';

export function registerIssueCommands(
  program: Command,
  createHandler: (action: (state: CliState, ...args: unknown[]) => Promise<void> | void) => (opts: GlobalOptions, ...args: unknown[]) => Promise<void>
): void {
  const issue = program.command('issue').description('Issue management');

  // Enhanced create command
  issue.command('create <title>')
    .description('Create issue with optional spec linking')
    .option('--repository <id>', 'Repository ID (required)')
    .option('--body <text>', 'Issue description')
    .option('--labels <items>', 'Comma-separated labels', (val) => val.split(','))
    .option('--spec <id>', 'Spec ID to link to')
    .option('--relationship <type>', 'Relationship type: reports-bug, requests-new, requests-change', 'reports-bug')
    .option('--new-spec-name <name>', 'Create new spec with this name')
    .option('--new-spec-desc <desc>', 'Description for new spec')
    .option('--skip-similarity', 'Skip duplicate check (for agents)', false)
    .option('--auto-link', 'Auto-link to best matching spec', false)
    .action(createHandler(async (state, title, options) => {
      if (!options.repository) {
        console.error(formatError('Repository ID is required'));
        process.exit(1);
      }

      const payload: CreateIssueWithSpecRequest = {
        title,
        repositoryId: options.repository,
        body: options.body,
        labels: options.labels,
        skipSimilarityCheck: options.skipSimilarity,
        autoLinkToSpec: options.autoLink,
      };

      // Handle spec linking
      if (options.spec) {
        payload.issueSpecLinks = [{
          specId: options.spec,
          relationship: options.relationship as 'reports-bug' | 'requests-new' | 'requests-change'
        }];
      }

      // Handle new spec creation
      if (options.newSpecName) {
        payload.createSpec = {
          name: options.newSpecName,
          description: options.newSpecDesc,
          contract: '{}', // Will need to be set properly
          declaredDeltaSurface: [],
          organizationId: '', // Will need to be determined
        };
      }

      const response = await state.client.createIssue(payload);
      
      if (state.outputFormat === 'json') {
        printOutput(response, { format: state.outputFormat, pretty: true });
      } else {
        console.log(formatSuccess(`Created issue #${response.data.issue.number}`));
        if (response.data.createdSpec) {
          console.log(formatSuccess(`Created spec: ${response.data.createdSpec.name}`));
        }
        if (response.data.createdLinks.length > 0) {
          console.log(formatSuccess(`Linked to ${response.data.createdLinks.length} spec(s)`));
        }
        if (response.data.duplicateWarning) {
          console.log(formatError(`Warning: Similar issues found: ${response.data.duplicateWarning.similarIssues.map(i => `#${i.number}`).join(', ')}`));
        }
      }
    }));

  // Other commands remain the same
  issue.command('list').description('List issues').action(createHandler(async (state) => {
    const response = await state.client.listIssues(100, 0);
    if (state.outputFormat === 'json') {
      printOutput(response, { format: state.outputFormat, pretty: true });
    } else {
      console.log(formatSuccess(`Found ${response.data.length} issue(s)`));
    }
  }));

  issue.command('get <id>').description('Get issue').action(createHandler(async (state, id) => {
    const i = await state.client.getIssue(id as string);
    printOutput(i, { format: state.outputFormat, pretty: true });
  }));
}
```

---

## Testing Strategy

### Unit Tests

**File:** `workers/shared/__tests__/similarity.test.ts`

```typescript
import { IssueSimilarityCalculator } from '../similarity';

describe('IssueSimilarityCalculator', () => {
  const calculator = new IssueSimilarityCalculator();

  describe('calculateSimilarity', () => {
    it('should return 100 for identical issues', async () => {
      const issue1 = { title: 'Fix login', description: 'The login is broken' };
      const issue2 = { title: 'Fix login', description: 'The login is broken' };
      
      const similarity = await calculator.calculateSimilarity(issue1, issue2);
      expect(similarity).toBe(100);
    });

    it('should return high similarity for similar issues', async () => {
      const issue1 = { title: 'Login endpoint returns 500', description: 'POST /api/login returns 500 on invalid input' };
      const issue2 = { title: 'Login endpoint error', description: 'The /api/login endpoint is returning 500 errors' };
      
      const similarity = await calculator.calculateSimilarity(issue1, issue2);
      expect(similarity).toBeGreaterThan(80);
    });

    it('should return low similarity for different issues', async () => {
      const issue1 = { title: 'Login problem', description: 'Cannot login' };
      const issue2 = { title: 'Logout issue', description: 'Cannot logout' };
      
      const similarity = await calculator.calculateSimilarity(issue1, issue2);
      expect(similarity).toBeLessThan(30);
    });
  });
});
```

---

## Performance Considerations

### Caching
- Cache similarity calculations for 5 minutes
- Cache spec matching results for 5 minutes
- Cache repository issue lists for 1 minute

### Indexing
- Ensure `idx_issues_repo` index exists for fast repository filtering
- Ensure `idx_specs_org` index exists for fast org filtering
- Consider full-text search indexes for better performance

### Query Optimization
- Limit similarity check to same repository only
- Limit spec suggestions to specs in same org or linked repos
- Use pagination for large result sets

---

## Security Considerations

### Input Validation
- Validate all inputs (title, description, spec data)
- Sanitize HTML in descriptions
- Validate JSON structures
- Check repository ownership/access

### Rate Limiting
- Limit similarity checks to 10 per minute per user
- Limit spec suggestions to 10 per minute per user
- Consider cost of operations

### Auth
- All endpoints require authentication
- Ensure actor ID is properly set
- Validate repository access

---

## Deployment Checklist

### Backend
- [ ] Add new endpoints to `workers/api/index.ts`
- [ ] Add new methods to SpecDO class
- [ ] Update database schema
- [ ] Add migration for new tables/columns
- [ ] Update Zod schemas in `workers/shared/schemas.ts`
- [ ] Add unit tests for new algorithms
- [ ] Add integration tests for new endpoints

### Frontend
- [ ] Create issue creation page
- [ ] Implement all UI components
- [ ] Add client-side validation
- [ ] Add loading states
- [ ] Add error handling

### CLI
- [ ] Update issue create command
- [ ] Add support for new fields
- [ ] Update documentation

### Documentation
- [ ] Update API documentation
- [ ] Update user guides
- [ ] Add examples
- [ ] Update README

---

## Monitoring

Add metrics for:
- Issue creation time
- Spec link rate
- Duplicate rate
- Suggestion acceptance rate
- Error rates on new endpoints

---

## Related Files

This implementation touches:

**Backend:**
- `workers/api/index.ts` - API routes
- `workers/spec-do/index.ts` - Spec DO class
- `workers/spec-do/schema.sql` - Database schema
- `workers/shared/schemas.ts` - Zod schemas
- `workers/shared/similarity.ts` - Similarity algorithms
- `workers/shared/spec-matcher.ts` - Spec matching algorithms
- `workers/shared/spec-extractor.ts` - Spec extraction
- `workers/shared/spec-validator.ts` - Spec validation

**Frontend:**
- `workers/api/ui.ts` - UI routes
- `workers/api/ui-pages.ts` - Page handlers
- `workers/api/ui-html.ts` - HTML helpers
- `workers/api/ui-issue-creation.ts` - New: Issue creation page

**CLI:**
- `cli/src/commands/issue.ts` - Issue commands

---

## Changelog

| Date | Author | Changes |
|------|--------|---------|
| 2026-10-14 | @bailey | Initial technical specification |
