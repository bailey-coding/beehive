import React, { useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { fetchCandidates, fetchSpecs } from '../services/api';
import type { Candidate, Spec, PaginatedResponse, CandidateFilter } from '../types';
import CandidateCard from '../components/CandidateCard';

const CandidatesPage: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [specs, setSpecs] = useState<Record<string, Spec>>({});
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<CandidateFilter>({});
  const [pagination, setPagination] = useState<PaginatedResponse<Candidate>['pagination']>({
    page: 1,
    pageSize: 20,
    total: 0,
    totalPages: 0,
  });

  // Parse candidateId from query params
  const searchParams = new URLSearchParams(location.search);
  const candidateId = searchParams.get('candidateId');

  useEffect(() => {
    loadData();
  }, [filter, pagination.page]);

  useEffect(() => {
    if (candidateId) {
      setFilter(prev => ({ ...prev, specId: undefined, agentId: undefined }));
    }
  }, [candidateId]);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      // Load candidates
      const candidatesResponse = await fetchCandidates(filter, pagination.page, pagination.pageSize);
      setCandidates(candidatesResponse.data);
      setPagination(candidatesResponse.pagination);

      // Load specs for reference
      const specsResponse = await fetchSpecs(1, 100);
      const specsMap: Record<string, Spec> = {};
      specsResponse.data.forEach(spec => {
        specsMap[spec.id] = spec;
      });
      setSpecs(specsMap);

      // Note: Verdicts would be loaded per-candidate in a real implementation
      // For now, we'll use mock/empty verdicts
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load candidates');
    } finally {
      setLoading(false);
    }
  };

  const handleFilterChange = (key: keyof CandidateFilter, value: string) => {
    setFilter(prev => ({ ...prev, [key]: value || undefined }));
    setPagination(prev => ({ ...prev, page: 1 }));
  };

  const handlePageChange = (newPage: number) => {
    setPagination(prev => ({ ...prev, page: newPage }));
  };



  const countByStage = (stage: string) => {
    return candidates.filter(c => c.stage === stage).length;
  };

  return (
    <div className="page candidates-page">
      <div className="page-header">
        <h1>Candidates</h1>
        <p className="page-description">
          Agent implementations competing to satisfy spec requirements.
        </p>
      </div>

      {/* Summary Stats */}
      <div className="summary-stats">
        <div className="stat-card">
          <span className="stat-value">{pagination.total}</span>
          <span className="stat-label">Total Candidates</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{countByStage('pending')}</span>
          <span className="stat-label">Pending</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{countByStage('passed_premerge')}</span>
          <span className="stat-label">Passed Pre-merge</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{countByStage('promoted')}</span>
          <span className="stat-label">Promoted</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{countByStage('failed')}</span>
          <span className="stat-label">Failed</span>
        </div>
      </div>

      {/* Filters */}
      <div className="filters">
        <div className="filter-group">
          <label>Spec:</label>
          <select
            value={filter.specId || ''}
            onChange={(e) => handleFilterChange('specId', e.target.value)}
          >
            <option value="">All Specs</option>
            {Object.values(specs).map(spec => (
              <option key={spec.id} value={spec.id}>{spec.name}</option>
            ))}
          </select>
        </div>
        <div className="filter-group">
          <label>Agent:</label>
          <input
            type="text"
            value={filter.agentId || ''}
            onChange={(e) => handleFilterChange('agentId', e.target.value)}
            placeholder="Filter by agent ID"
          />
        </div>
        <div className="filter-group">
          <label>Stage:</label>
          <select
            value={filter.stage || ''}
            onChange={(e) => handleFilterChange('stage', e.target.value)}
          >
            <option value="">All Stages</option>
            <option value="pending">Pending</option>
            <option value="passed_premerge">Passed Pre-merge</option>
            <option value="passed_shadow">Passed Shadow</option>
            <option value="passed_train">Passed Train</option>
            <option value="passed_canary">Passed Canary</option>
            <option value="promoted">Promoted</option>
            <option value="failed">Failed</option>
            <option value="rolled_back">Rolled Back</option>
          </select>
        </div>
      </div>

      {/* Loading / Error */}
      {loading && (
        <div className="loading">
          <div className="spinner"></div>
          <p>Loading candidates...</p>
        </div>
      )}

      {error && (
        <div className="error-message">
          <p>{error}</p>
          <button onClick={loadData}>Retry</button>
        </div>
      )}

      {/* Candidates List */}
      {!loading && !error && (
        <>
          {candidates.length === 0 ? (
            <div className="empty-state">
              <p>No candidates found.</p>
              <p>Run agents against specs to generate candidates.</p>
            </div>
          ) : (
            <div className="candidate-grid">
              {candidates.map((candidate) => (
                <CandidateCard
                  key={candidate.id}
                  candidate={candidate}
                  spec={specs[candidate.specId]}
                  onSelect={() => navigate(`/candidates?candidateId=${candidate.id}`)}
                />
              ))}
            </div>
          )}

          {/* Pagination */}
          {pagination.totalPages > 1 && (
            <div className="pagination">
              <button
                disabled={pagination.page <= 1}
                onClick={() => handlePageChange(pagination.page - 1)}
              >
                Previous
              </button>
              <span className="pagination-info">
                Page {pagination.page} of {pagination.totalPages}
                ({pagination.total} total)
              </span>
              <button
                disabled={pagination.page >= pagination.totalPages}
                onClick={() => handlePageChange(pagination.page + 1)}
              >
                Next
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default CandidatesPage;
