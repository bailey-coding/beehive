import React from 'react';
import { useNavigate } from 'react-router-dom';
import type { Trial } from '../types';
import StageBadge from './StageBadge';

interface TrialCardProps {
  trial: Trial;
  onClick: (trialId: string) => void;
}

const TrialCard: React.FC<TrialCardProps> = ({ trial, onClick }) => {
  const navigate = useNavigate();

  const handleClick = () => {
    onClick(trial.id);
  };

  const getCandidateLabels = () => {
    const aLabel = trial.candidateAId?.slice(-4) || 'A';
    const bLabel = trial.candidateBId?.slice(-4) || 'B';
    return `${aLabel} vs ${bLabel}`;
  };

  return (
    <div className="trial-card" onClick={handleClick}>
      <div className="trial-card-header">
        <span className="trial-id">Trial: {trial.id.slice(-8)}</span>
        <StageBadge stage={trial.stage} type="trial" />
      </div>
      <div className="trial-card-body">
        <p className="trial-spec">Spec: {trial.specId?.slice(-8)}</p>
        <p className="trial-candidates">{getCandidateLabels()}</p>
        {trial.decidedAt && (
          <p className="trial-decided">
            Decided: {new Date(trial.decidedAt).toLocaleDateString()}
          </p>
        )}
        {trial.winnerId && (
          <p className="trial-winner">
            Winner: {trial.winnerId === trial.candidateAId ? 'A' : 'B'}
          </p>
        )}
      </div>
    </div>
  );
};

export default TrialCard;
