/**
 * The line a team settings section shows when the workspace's plan does not
 * include its feature: which plan does, and a link to the billing page.
 */

import React from 'react';
import {
  FEATURE_PLAN_NAMES,
  billingSettingsPath,
  type GatedFeature,
} from '../../lib/billing';
import TextLink from '../ui/link';

/** Props for PlanRequiredNote. */
export interface PlanRequiredNoteProps {
  feature: GatedFeature;
  /** What the feature is called in the sentence, such as "Triage". */
  name: string;
  /** The workspace slug the billing link points into. */
  slug: string;
}

/** Says a feature needs a higher plan and links to where to upgrade. */
export const PlanRequiredNote: React.FC<PlanRequiredNoteProps> = ({
  feature,
  name,
  slug,
}) => (
  <p className="rounded-md border border-line bg-surface px-3 py-2 text-sm text-text-muted">
    {name} needs the {FEATURE_PLAN_NAMES[feature]} plan.{' '}
    <TextLink to={billingSettingsPath(slug)}>View plans</TextLink>
  </p>
);

export default PlanRequiredNote;
