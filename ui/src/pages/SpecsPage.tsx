import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { fetchSpecs, fetchActors } from '../services/api';
import type { Spec, Actor, PaginatedResponse } from '../types';
import StageBadge from '../components/StageBadge';

const SpecsPage: React.FC = () => {
  const navigate = useNavigate();
  const [specs, setSpecs] = useState<Spec[]>([]);
  const [actors, setActors] = useState<Record<string, Actor>>({});
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [pagination, setPagination] = useState<PaginatedResponse<Spec>['pagination']>({
    page: 1,
    pageSize: 20,
    total: 0,
    totalPages: 0,
  });

  useEffect(() => {
    loadData();
  }, [pagination.page]);

  const loadData = async () => {
    setLoading(true);
    setError(null);
    try {
      // Load specs
      const specsResponse = await fetchSpecs(pagination.page, pagination.pageSize);
      setSpecs(specsResponse.data);
      setPagination(specsResponse.pagination);

      // Load actors for reference
      const actorsResponse = await fetchActors(1, 100);
      const actorsMap: Record<string, Actor> = {};
      actorsResponse.data.forEach(actor => {
        actorsMap[actor.id] = actor;
      });
      setActors(actorsMap);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load specs');
    } finally {
      setLoading(false);
    }
  };

  const handlePageChange = (newPage: number) => {
    setPagination(prev => ({ ...prev, page: newPage }));
  };

  const getActorName = (actorId: string) => {
    return actors[actorId]?.name || actorId;
  };

  const countByStage = (stage: string) => {
    return specs.filter(s => s.stage === stage).length;
  };

  const handleSpecClick = (specId: string) => {
    navigate(`/specs?specId=${specId}`);
  };

  return (
    <div className="page specs-page">
      <div className="page-header">
        <h1>Specs</h1>
        <p className="page-description">
          Machine-readable contracts that define what agents must implement.
        </p>
      </div>

      {/* Summary Stats */}
      <div className="summary-stats">
        <div className="stat-card">
          <span className="stat-value">{pagination.total}</span>
          <span className="stat-label">Total Specs</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{countByStage('draft')}</span>
          <span className="stat-label">Draft</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{countByStage('active')}</span>
          <span className="stat-label">Active</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{countByStage('proposed')}</span>
          <span className="stat-label">Proposed</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{countByStage('archived') + countByStage('deprecated')}</span>
          <span className="stat-label">Archived/Deprecated</span>
        </div>
      </div>

      {/* Loading / Error */}
      {loading && (
        <div className="loading">
          <div className="spinner"></div>
          <p>Loading specs...</p>
        </div>
      )}

      {error && (
        <div className="error-message">
          <p>{error}</p>
          <button onClick={loadData}>Retry</button>
        </div>
      )}

      {/* Specs List */}
      {!loading && !error && (
        <>
          {specs.length === 0 ? (
            <div className="empty-state">
              <p>No specs found.</p>
              <p>Create a spec to define what agents should implement.</p>
            </div>
          ) : (
            <div className="spec-list">
              {specs.map((spec) => (
                <div
                  key={spec.id}
                  className="spec-card"
                  onClick={() => handleSpecClick(spec.id)}
                >
                  <div className="spec-header">
                    <h3>{spec.name}</h3>
                    <StageBadge stage={spec.stage} type="spec" />
                  </div>
                  <div className="spec-body">
                    {spec.description && (
                      <p className="description">{spec.description}</p>
                    )}
                    <div className="spec-meta">
                      <span className="meta-item">
                        <span className="label">ID:</span>
                        <span className="value">{spec.id}</span>
                      </span>
                      <span className="meta-item">
                        <span className="label">Created By:</span>
                        <span className="value">{getActorName(spec.createdBy)}</span>
                      </span>
                      <span className="meta-item">
                        <span className="label">Created:</span>
                        <span className="value">
                          {new Date(spec.createdAt).toLocaleString()}
                        </span>
                      </span>
                    </div>
                    <div className="spec-contract-preview">
                      <span className="label">Contract Preview:</span>
                      <pre className="contract-snippet">{spec.contract.slice(0, 200)}...</pre>
                    </div>
                    <div className="spec-delta-surface">
                      <span className="label">Declared Delta Surface:</span>
                      <div className="delta-chips">
                        {(typeof spec.declaredDeltaSurface === 'string' 
                          ? JSON.parse(spec.declaredDeltaSurface)
                          : spec.declaredDeltaSurface || []).map((item: string, idx: number) => (
                          <span key={idx} className="delta-chip">{item}</span>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
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

export default SpecsPage;
