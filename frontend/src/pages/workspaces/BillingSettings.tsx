/**
 * The Billing page of workspace settings: the workspace's plan and what it
 * grants, how much of its pooled storage is in use, and the way to a paid plan.
 *
 * Any member may read the plan, so a person who hit a limit can see why. Only
 * an owner or admin is offered Checkout and the portal, which mirrors the
 * server: both routes are admin only. Checkout and the portal are hosted by
 * Stripe, so each button asks the API for a URL and sends the browser there;
 * the plan itself changes when Stripe's webhook lands, not on the way back.
 * A workspace on an internal comp grant shows that plan as complimentary and is
 * offered neither Checkout nor the portal for it.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  createCheckoutSession,
  createPortalSession,
  getBilling,
  getStorageUsage,
} from '../../api/billing';
import { ConfirmationAlert, ErrorAlert } from '../../components/ui/alert';
import Badge from '../../components/ui/badge';
import Button from '../../components/ui/button';
import { SkeletonRows } from '../../components/ui/skeleton';
import SettingsNav from '../../components/workspace/SettingsNav';
import WorkspaceShell from '../../components/workspace/WorkspaceShell';
import { useWorkspace } from '../../hooks/useWorkspace';
import {
  checkoutOutcome,
  FEATURE_LABELS,
  formatBytes,
  PLAN_OFFERS,
  planName,
  priceLine,
  RESOURCE_LABELS,
  sendBrowserTo,
  subscriptionStatusLabel,
  usagePercent,
} from '../../lib/billing';
import { canManageMembers } from '../../lib/capabilities';
import { cn } from '../../lib/cn';
import { errorMessage } from '../../lib/errors';
import type {
  BillingInterval,
  BillingRead,
  PaidPlan,
  StorageUsageRead,
} from '../../types/Api';

/** A date as the page shows it, or null when there is none. */
const formatDate = (value: string | null): string | null => {
  if (value === null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
};

/** Whether a live internal comp grant holds the workspace on its plan. */
const isComped = (billing: BillingRead): boolean =>
  billing.comp_plan !== undefined && billing.comp_plan !== null;

/** A section heading with its one line of explanation. */
const SectionHeading: React.FC<{
  id: string;
  title: string;
  description: string;
}> = ({ id, title, description }) => (
  <div className="space-y-1">
    <h2 id={id} className="text-base font-semibold">
      {title}
    </h2>
    <p className="text-sm text-text-muted">{description}</p>
  </div>
);

/** The plan the workspace is on, its subscription and its seats. */
const CurrentPlan: React.FC<{
  billing: BillingRead;
  canManage: boolean;
  busy: boolean;
  onManage: () => void;
}> = ({ billing, canManage, busy, onManage }) => {
  const comped = isComped(billing);
  const status = comped
    ? 'Complimentary'
    : subscriptionStatusLabel(billing.subscription_status);
  const periodEnd = comped ? null : formatDate(billing.current_period_end);
  const compEnds = comped ? formatDate(billing.comp_expires_at ?? null) : null;
  const seats = billing.billed_seats ?? billing.seats_in_use;
  const interval = comped
    ? null
    : billing.billing_interval === 'year'
      ? 'Billed annually'
      : billing.billing_interval === 'month'
        ? 'Billed monthly'
        : null;

  return (
    <section aria-labelledby="billing-plan" className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <SectionHeading
          id="billing-plan"
          title="Plan"
          description="What this workspace is on and what it is billed for."
        />
        {canManage &&
          !comped &&
          billing.billing_enabled &&
          billing.has_billing_account && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onManage}
              disabled={busy}
            >
              Manage billing
            </Button>
          )}
      </div>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 rounded-md border border-line px-4 py-3 text-sm">
        <dt className="text-text-muted">Plan</dt>
        <dd className="flex items-center gap-2">
          <span className="font-medium">{planName(billing.plan)}</span>
          {status !== null && (
            <Badge
              tone={
                comped ||
                billing.subscription_status === 'active' ||
                billing.subscription_status === 'trialing'
                  ? 'success'
                  : 'warning'
              }
            >
              {status}
            </Badge>
          )}
        </dd>
        {interval !== null && (
          <>
            <dt className="text-text-muted">Billing</dt>
            <dd>{interval}</dd>
          </>
        )}
        <dt className="text-text-muted">Seats</dt>
        <dd>
          {billing.billed_seats === null
            ? `${billing.seats_in_use} in use`
            : `${billing.seats_in_use} in use of ${seats} billed`}
        </dd>
        {compEnds !== null && (
          <>
            <dt className="text-text-muted">Ends</dt>
            <dd>{compEnds}</dd>
          </>
        )}
        {periodEnd !== null && (
          <>
            <dt className="text-text-muted">
              {billing.cancel_at_period_end ? 'Ends' : 'Renews'}
            </dt>
            <dd>{periodEnd}</dd>
          </>
        )}
      </dl>
      {billing.cancel_at_period_end && periodEnd !== null && (
        <p className="text-sm text-warning">
          The subscription is cancelled and the workspace returns to Free on{' '}
          {periodEnd}.
        </p>
      )}
    </section>
  );
};

/** The pooled storage bar and the plan's other limits. */
const Usage: React.FC<{
  billing: BillingRead;
  storage: StorageUsageRead | null;
}> = ({ billing, storage }) => {
  const limit = storage?.limit_bytes ?? billing.storage_bytes;
  const used = storage?.used_bytes ?? 0;
  const percent = usagePercent(used, limit);
  const guests = billing.guests_per_seat * Math.max(1, billing.seats_in_use);
  const features = billing.features.map(
    (feature) => FEATURE_LABELS[feature] ?? feature
  );

  return (
    <section aria-labelledby="billing-usage" className="space-y-3">
      <SectionHeading
        id="billing-usage"
        title="Usage"
        description="What the plan allows and how much of it is in use."
      />
      <div className="space-y-2 rounded-md border border-line px-4 py-3">
        <div className="flex items-baseline justify-between text-sm">
          <span className="font-medium">Storage</span>
          <span className="text-text-muted">
            {storage === null
              ? `${formatBytes(limit)} included`
              : `${formatBytes(used)} of ${formatBytes(limit)}`}
          </span>
        </div>
        <div
          role="progressbar"
          aria-label="Storage used"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          className="h-1.5 w-full overflow-hidden rounded-full bg-raised"
        >
          <div
            className={cn(
              'h-full rounded-full',
              percent >= 90 ? 'bg-danger' : 'bg-accent'
            )}
            style={{ width: `${percent}%` }}
          />
        </div>
        <p className="text-xs text-text-faint">
          Attachments across every team count toward one pool.
        </p>
      </div>
      <dl className="grid grid-cols-[1fr_max-content] gap-x-6 gap-y-2 rounded-md border border-line px-4 py-3 text-sm">
        {Object.entries(billing.limits).map(([resource, value]) => (
          <React.Fragment key={resource}>
            <dt className="text-text-muted">
              {RESOURCE_LABELS[resource] ?? resource}
            </dt>
            <dd className="text-right tabular-nums">
              {value.toLocaleString()}
            </dd>
          </React.Fragment>
        ))}
        <dt className="text-text-muted">Guests</dt>
        <dd className="text-right tabular-nums">
          {billing.guests_per_seat === 0
            ? 'Not included'
            : `${guests.toLocaleString()} (${billing.guests_per_seat} per seat)`}
        </dd>
      </dl>
      {features.length > 0 && (
        <p className="text-sm text-text-muted">
          Includes {features.join(', ')}.
        </p>
      )}
    </section>
  );
};

/** The paid plans, the billing interval switch and the upgrade buttons. */
const Plans: React.FC<{
  billing: BillingRead;
  busy: boolean;
  onUpgrade: (plan: PaidPlan, interval: BillingInterval) => void;
}> = ({ billing, busy, onUpgrade }) => {
  const [interval, setInterval] = useState<BillingInterval>('year');

  return (
    <section aria-labelledby="billing-upgrade" className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <SectionHeading
          id="billing-upgrade"
          title="Upgrade"
          description="Paid plans bill per seat. Guests do not take a seat."
        />
        <div
          role="radiogroup"
          aria-label="Billing interval"
          className="inline-flex rounded-md border border-line p-0.5"
        >
          {(['year', 'month'] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={interval === value}
              onClick={() => {
                setInterval(value);
              }}
              className={cn(
                'h-6 rounded-sm px-2 text-xs transition-colors duration-100',
                interval === value
                  ? 'bg-raised font-medium text-text'
                  : 'text-text-muted hover:text-text'
              )}
            >
              {value === 'year' ? 'Annually' : 'Monthly'}
            </button>
          ))}
        </div>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2">
        {PLAN_OFFERS.map((offer) => {
          const available =
            offer.plan !== 'business' || billing.business_available;
          return (
            <li
              key={offer.plan}
              className="flex flex-col gap-3 rounded-md border border-line px-4 py-3"
            >
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold">{offer.name}</h3>
                  {!available && <Badge>Coming soon</Badge>}
                </div>
                <p className="text-sm">{priceLine(offer, interval)}</p>
                <p className="text-xs text-text-muted">{offer.summary}</p>
              </div>
              <div className="mt-auto">
                <Button
                  type="button"
                  variant={offer.plan === 'standard' ? 'primary' : 'secondary'}
                  size="sm"
                  disabled={busy || !available}
                  onClick={() => {
                    onUpgrade(offer.plan, interval);
                  }}
                >
                  Upgrade to {offer.name}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
};

/** The billing settings page. */
const BillingSettings: React.FC = () => {
  const { workspace } = useWorkspace();
  const [params] = useSearchParams();
  const [billing, setBilling] = useState<BillingRead | null>(null);
  const [storage, setStorage] = useState<StorageUsageRead | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const workspaceId = workspace?.id ?? null;
  const canManage = canManageMembers(workspace?.role);
  const outcome = checkoutOutcome(params.get('checkout'));

  useEffect(() => {
    if (workspaceId === null) return;
    const controller = new AbortController();
    getBilling(workspaceId, controller.signal)
      .then((read) => {
        setBilling(read);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setLoadError(error);
      });
    getStorageUsage(workspaceId, controller.signal)
      .then(setStorage)
      .catch(() => {
        if (!controller.signal.aborted) setStorage(null);
      });
    return () => {
      controller.abort();
    };
  }, [workspaceId]);

  const upgrade = useCallback(
    (plan: PaidPlan, interval: BillingInterval) => {
      if (workspaceId === null) return;
      setBusy(true);
      setActionError(null);
      createCheckoutSession(workspaceId, { plan, interval })
        .then(sendBrowserTo)
        .catch((error: unknown) => {
          setActionError(errorMessage(error, 'Could not start checkout.'));
          setBusy(false);
        });
    },
    [workspaceId]
  );

  const manage = useCallback(() => {
    if (workspaceId === null) return;
    setBusy(true);
    setActionError(null);
    createPortalSession(workspaceId)
      .then(sendBrowserTo)
      .catch((error: unknown) => {
        setActionError(errorMessage(error, 'Could not open billing.'));
        setBusy(false);
      });
  }, [workspaceId]);

  const onFree =
    billing !== null && billing.plan === 'free' && !isComped(billing);

  return (
    <WorkspaceShell
      title="Settings"
      toolbar={
        workspace === null ? undefined : <SettingsNav workspace={workspace} />
      }
    >
      <div className="max-w-2xl space-y-8">
        {outcome !== null &&
          (outcome.tone === 'success' ? (
            <ConfirmationAlert message={outcome.message} />
          ) : (
            <p
              role="status"
              className="rounded-md border border-line px-3 py-2 text-sm text-text-muted"
            >
              {outcome.message}
            </p>
          ))}
        <ErrorAlert message={actionError} />
        {loadError !== null && (
          <ErrorAlert
            message={errorMessage(loadError, 'Could not load billing.')}
          />
        )}
        {billing === null ? (
          loadError === null && (
            <SkeletonRows count={4} label="Loading billing" />
          )
        ) : (
          <>
            <CurrentPlan
              billing={billing}
              canManage={canManage}
              busy={busy}
              onManage={manage}
            />
            <Usage billing={billing} storage={storage} />
            {onFree && !billing.billing_enabled && (
              <p className="rounded-md border border-line px-4 py-3 text-sm text-text-muted">
                Paid plans are not on sale yet. Until they are, the free plan
                keeps its higher preview limits.
              </p>
            )}
            {onFree && billing.billing_enabled && canManage && (
              <Plans billing={billing} busy={busy} onUpgrade={upgrade} />
            )}
            {onFree && billing.billing_enabled && !canManage && (
              <p className="text-sm text-text-muted">
                A workspace owner or admin can upgrade the plan.
              </p>
            )}
          </>
        )}
      </div>
    </WorkspaceShell>
  );
};

export default BillingSettings;
