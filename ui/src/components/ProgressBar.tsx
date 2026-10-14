import React from 'react';

interface ProgressBarProps {
  value: number;
  max: number;
  label?: string;
  color?: 'primary' | 'success' | 'warning' | 'danger' | 'critical';
}

const ProgressBar: React.FC<ProgressBarProps> = ({ value, max, label, color = 'primary' }) => {
  const percentage = Math.min(100, Math.max(0, (value / max) * 100));

  return (
    <div className="progress-bar-container">
      {label && <span className="progress-bar-label">{label}</span>}
      <div className="progress-bar-track">
        <div
          className={`progress-bar-fill progress-bar-fill-${color}`}
          style={{ width: `${percentage}%` }}
        />
      </div>
      <span className="progress-bar-value">{Math.round(percentage)}%</span>
    </div>
  );
};

export default ProgressBar;
