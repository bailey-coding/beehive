import React from 'react';

type EntityType = 'candidate' | 'trial' | 'gate' | 'spec' | 'issue' | 'promotion';

interface StageBadgeProps {
  stage: string;
  type: EntityType;
}

const StageBadge: React.FC<StageBadgeProps> = ({ stage, type }) => {
  const getStageConfig = () => {
    const configs: Record<EntityType, Record<string, { label: string; color: string }>> = {
      candidate: {
        pending: { label: 'Pending', color: 'secondary' },
        passed_premerge: { label: 'Passed Pre-merge', color: 'success' },
        passed_shadow: { label: 'Passed Shadow', color: 'success' },
        passed_train: { label: 'Passed Train', color: 'success' },
        passed_canary: { label: 'Passed Canary', color: 'success' },
        promoted: { label: 'Promoted', color: 'success' },
        failed: { label: 'Failed', color: 'danger' },
        rolled_back: { label: 'Rolled Back', color: 'critical' },
      },
      trial: {
        pending: { label: 'Pending', color: 'secondary' },
        comparing: { label: 'Comparing', color: 'primary' },
        decided: { label: 'Decided', color: 'success' },
      },
      gate: {
        pending: { label: 'Pending', color: 'secondary' },
        passed: { label: 'Passed', color: 'success' },
        failed: { label: 'Failed', color: 'danger' },
      },
      spec: {
        draft: { label: 'Draft', color: 'secondary' },
        proposed: { label: 'Proposed', color: 'primary' },
        active: { label: 'Active', color: 'success' },
        deprecated: { label: 'Deprecated', color: 'warning' },
        archived: { label: 'Archived', color: 'secondary' },
      },
      issue: {
        reported: { label: 'Reported', color: 'secondary' },
        spec_needed: { label: 'Spec Needed', color: 'primary' },
        spec_defining: { label: 'Spec Defining', color: 'primary' },
        spec_defined: { label: 'Spec Defined', color: 'success' },
        implementing: { label: 'Implementing', color: 'primary' },
        validating: { label: 'Validating', color: 'primary' },
        merged: { label: 'Merged', color: 'success' },
        closed: { label: 'Closed', color: 'secondary' },
      },
      promotion: {
        pending: { label: 'Pending', color: 'secondary' },
        active: { label: 'Active', color: 'success' },
        rolled_back: { label: 'Rolled Back', color: 'critical' },
      },
    };

    const config = configs[type]?.[stage] || { label: stage, color: 'secondary' };
    return config;
  };

  const { label, color } = getStageConfig();

  return (
    <span className={`stage-badge stage-badge-${color}`}>
      {label}
    </span>
  );
};

export default StageBadge;
