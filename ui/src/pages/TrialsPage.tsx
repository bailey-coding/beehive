import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchTrials } from '../services/api';
import type { Trial, TrialFilter, PaginatedResponse } from '../types';
import TrialCard from '../components/TrialCard';

const TrialsPage: React.FC = () => {
  const navigate = useNavigate();
  const [trials, setTrials] = useState<Trial[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<TrialFilter>({});
  const [pagination, setPagination] = useState<PaginatedResponse<Trial>['pagination']>({
    page: 1,
    pageSize: 20,
    total: 0,
    totalPages: 0,
  });

  useEffect(() => {
    loadTrials();
  }, [filter, pagination.page]);

  const loadTrials = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchTrials(filter, pagination.page, pagination.pageSize);
      setTrials(response.data);
      setPagination(response.pagination);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load trials');
    } finally {
      setLoading(false);
    }
  };

  const handleTrialClick = (trialId: string) => {
    navigate(`/trials/${trialId}`);
  };

  const handleFilterChange = (key: keyof TrialFilter, value: string) => {
    setFilter(prev => ({ ...prev, [key]: value || undefined }));
    setPagination(prev => ({ ...prev, page: 1 }));
  };

  const handlePageChange = (newPage: number) => {
    setPagination(prev => ({ ...prev, page: newPage }));
  };

  return (
    <div className="page trials-page">
      <div className="page-header">
        <h1>Trials</h1>
        <p className="page-description">
          Competitive evaluations between candidate implementations of the same spec.
        </p>
      </div>

      {/* Filters */}
      <div className="filters">
        <div className="filter-group">
          <label>Stage:</label>
          <select
            value={filter.stage || ''}
            onChange={(e) => handleFilterChange('stage', e.target.value)}
          >
            <option value="">All Stages</option>
            <option value="pending">Pending</option>
            <option value="comparing">Comparing</option>
            <option value="decided">Decided</option>
          </select>
        </div>
        <div className="filter-group">
          <label>Spec ID:</label>
          <input
            type="text"
            value={filter.specId || ''}
            onChange={(e) => handleFilterChange('specId', e.target.value)}
            placeholder="Filter by spec ID"
          />
        </div>
      </div>

      {/* Loading / Error */}
      {loading && (
        <div className="loading">
          <div className="spinner"></div>
          <p>Loading trials...</p>
        </div>
      )}

      {error && (
        <div className="error-message">
          <p>{error}</p>
          <button onClick={loadTrials}>Retry</button>
        </div>
      )}

      {/* Trials List */}
      {!loading && !error && (
        <>
          {trials.length === 0 ? (
            <div className="empty-state">
              <p>No trials found.</p>
              <p>Create a spec and run agents to generate trials.</p>
            </div>
          ) : (
            <div className="trial-grid">
              {trials.map((trial) => (
                <TrialCard
                  key={trial.id}
                  trial={trial}
                  onClick={() => handleTrialClick(trial.id)}
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

export default TrialsPage;
