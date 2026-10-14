import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { fetchTrialById } from '../services/api';
import type { TrialComparison } from '../types';
import CandidateCard from '../components/CandidateCard';
import ScoreBadge from '../components/ScoreBadge';
import StageBadge from '../components/StageBadge';
import ProgressBar from '../components/ProgressBar';

const TrialDetailPage: React.FC = () => {
  const { trialId } = useParams<{ trialId: string }>();
  const navigate = useNavigate();
  const [trialData, setTrialData] = useState<TrialComparison | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!trialId) return;
    loadTrialData();
  }, [trialId]);

  const loadTrialData = async () => {
    if (!trialId) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetchTrialById(trialId);
      setTrialData(response.data || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load trial details');
    } finally {
      setLoading(false);
    }
  };

  if (!trialId) {
    return (
      <div className="page error-page">
        <h1>Trial Not Found</h1>
        <p>Invalid trial ID.</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="page loading-page">
        <div className="spinner"></div>
        <p>Loading trial details...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="page error-page">
        <h1>Error</h1>
        <p>{error}</p>
        <button onClick={loadTrialData}>Retry</button>
      </div>
    );
  }

  if (!trialData) {
    return (
      <div className="page error-page">
        <h1>Trial Not Found</h1>
        <p>Trial with ID "{trialId}" does not exist.</p>
      </div>
    );
  }

  const { trial, candidateA, candidateB, verdictA, verdictB, winner } = trialData;

  const getWinnerName = () => {
    if (winner) return `Candidate ${winner.id.slice(-4)}`;
    if (trial.winnerId === candidateA?.id) return `Candidate A`;
    if (trial.winnerId === candidateB?.id) return `Candidate B`;
    return 'Undecided';
  };

  const calculateProgress = () => {
    if (trial.stage === 'decided') return 100;
    if (trial.stage === 'comparing') return 66;
    return 33;
  };

  return (
    <div className="page trial-detail-page">
      <div className="page-header">
        <button className="back-button" onClick={() => navigate('/')}>← Back to Trials</button>
        <div className="header-content">
          <h1>Trial: {trial.id}</h1>
          <StageBadge stage={trial.stage} type="trial" />
        </div>
      </div>

      {/* Trial Metadata */}
      <div className="trial-metadata">
        <div className="metadata-grid">
          <div className="metadata-item">
            <span className="label">Spec:</span>
            <span className="value">{trial.specId}</span>
          </div>
          <div className="metadata-item">
            <span className="label">Status:</span>
            <StageBadge stage={trial.stage} type="trial" />
          </div>
          <div className="metadata-item">
            <span className="label">Decided At:</span>
            <span className="value">
              {trial.decidedAt ? new Date(trial.decidedAt).toLocaleString() : 'Not decided'}
            </span>
          </div>
          <div className="metadata-item">
            <span className="label">Decided By:</span>
            <span className="value">{trial.decidedBy || 'N/A'}</span>
          </div>
        </div>
        
        <ProgressBar
          value={calculateProgress()}
          max={100}
          label={`Progress: ${calculateProgress()}%`}
          color={trial.stage === 'decided' ? 'success' : 'primary'}
        />
      </div>

      {/* Winner Announcement */}
      {trial.stage === 'decided' && (
        <div className="winner-announcement">
          <h2>🏆 Winner: {getWinnerName()}</h2>
          {winner && (
            <p>
              Candidate {winner.id.slice(-4)} was selected as the winner of this trial.
            </p>
          )}
        </div>
      )}

      {/* Candidates Comparison */}
      <div className="trial-comparison">
        <h2>Candidates</h2>
        <div className="candidates-grid">
          {/* Candidate A */}
          <div className="candidate-section">
            <h3>Candidate A</h3>
            {candidateA ? (
              <>
                <CandidateCard
                  candidate={candidateA}
                  verdict={verdictA}
                  spec={trialData.spec}
                  onSelect={() => navigate(`/candidates?candidateId=${candidateA.id}`)}
                />
                {verdictA && (
                  <div className="verdict-details">
                    <h4>Pre-merge Gate</h4>
                    <StageBadge stage={verdictA.stage} type="gate" />
                    <ScoreBadge score={verdictA.score} maxScore={100} />
                    <p>Complexity Delta: {verdictA.complexityDelta}</p>
                    {verdictA.notes && <p className="notes">Notes: {verdictA.notes}</p>}
                  </div>
                )}
              </>
            ) : (
              <p>Candidate A not found</p>
            )}
          </div>

          {/* Candidate B */}
          <div className="candidate-section">
            <h3>Candidate B</h3>
            {candidateB ? (
              <>
                <CandidateCard
                  candidate={candidateB}
                  verdict={verdictB}
                  spec={trialData.spec}
                  onSelect={() => navigate(`/candidates?candidateId=${candidateB.id}`)}
                />
                {verdictB && (
                  <div className="verdict-details">
                    <h4>Pre-merge Gate</h4>
                    <StageBadge stage={verdictB.stage} type="gate" />
                    <ScoreBadge score={verdictB.score} maxScore={100} />
                    <p>Complexity Delta: {verdictB.complexityDelta}</p>
                    {verdictB.notes && <p className="notes">Notes: {verdictB.notes}</p>}
                  </div>
                )}
              </>
            ) : (
              <p>Candidate B not found</p>
            )}
          </div>
        </div>
      </div>

      {/* Comparison Metrics */}
      {trial.comparisonMetrics && (
        <div className="comparison-metrics">
          <h2>Comparison Metrics</h2>
          <table className="metrics-table">
            <thead>
              <tr>
                <th>Metric</th>
                <th>Candidate A</th>
                <th>Candidate B</th>
              </tr>
            </thead>
            <tbody>
              {trial.comparisonMetrics.conformance_score && (
                <tr>
                  <td>Conformance Score</td>
                  <td>{trial.comparisonMetrics.conformance_score.a}</td>
                  <td>{trial.comparisonMetrics.conformance_score.b}</td>
                </tr>
              )}
              {trial.comparisonMetrics.complexity_delta && (
                <tr>
                  <td>Complexity Delta</td>
                  <td>{trial.comparisonMetrics.complexity_delta.a}</td>
                  <td>{trial.comparisonMetrics.complexity_delta.b}</td>
                </tr>
              )}
              {trial.comparisonMetrics.performance && (
                <tr>
                  <td>Performance</td>
                  <td>{trial.comparisonMetrics.performance.a}</td>
                  <td>{trial.comparisonMetrics.performance.b}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default TrialDetailPage;
