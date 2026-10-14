import React from 'react';

interface ScoreBadgeProps {
  score: number;
  maxScore?: number;
}

const ScoreBadge: React.FC<ScoreBadgeProps> = ({ score, maxScore = 100 }) => {
  const percentage = (score / maxScore) * 100;

  const getColor = () => {
    if (percentage >= 80) return 'success';
    if (percentage >= 60) return 'warning';
    if (percentage >= 40) return 'danger';
    return 'critical';
  };

  const color = getColor();

  return (
    <span className={`score-badge score-badge-${color}`}>
      {score}/{maxScore}
    </span>
  );
};

export default ScoreBadge;
