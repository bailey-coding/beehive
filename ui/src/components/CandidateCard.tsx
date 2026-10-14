import React from 'react';
import type { Candidate, Spec, GateVerdict } from '../types';
import StageBadge from './StageBadge';
import ScoreBadge from './ScoreBadge';

interface CandidateCardProps {
  candidate: Candidate;
  verdict?: GateVerdict;
  spec?: Spec;
  onSelect?: () => void;
}

const CandidateCard: React.FC<CandidateCardProps> = ({ candidate, verdict, spec, onSelect }) => {
  const handleClick = () => {
    if (onSelect) onSelect();
  };

  return (
    <div className="candidate-card" onClick={handleClick}>
      <div className="candidate-card-header">
        <span className="candidate-id">Candidate: {candidate.id.slice(-8)}</span>
        <StageBadge stage={candidate.stage} type="candidate" />
      </div>
      <div className="candidate-card-body">
        {spec && <p className="candidate-spec">Spec: {spec.name || spec.id.slice(-8)}</p>}
        <p className="candidate-repo">Repo: {candidate.repositoryId?.slice(-8)}</p>
        <p className="candidate-sha">Commit: {candidate.commitSha?.slice(0, 7)}</p>
        {verdict && (
          <div className="candidate-verdict">
            <ScoreBadge score={verdict.score} maxScore={100} />
            <p>Gate: {verdict.gate}</p>
            <p>Status: {verdict.status}</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default CandidateCard;
