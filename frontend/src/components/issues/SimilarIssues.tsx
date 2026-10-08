/**
 * The "Similar issues" strip under a draft title in the create dialog. While
 * a person types, the title is matched against the search index after a short
 * pause, and up to five open issues that share its words are listed with their
 * key, title and status. Each row opens the issue in a new tab, so the draft
 * survives, or marks the new issue as a duplicate of it.
 *
 * The match is the server's deterministic term overlap. The client keeps it
 * cheap: nothing is asked until the title holds a searchable word, one request
 * goes out per pause, and a newer pause cancels the one still in flight.
 */

import React, { useEffect, useState } from 'react';
import { similarIssues } from '../../api/views';
import { cn } from '../../lib/cn';
import type { StatusLike } from '../../lib/statusAppearance';
import type { SimilarIssueRead } from '../../types/Api';
import { StatusIcon } from '../ui/StatusIcon';

/** How long typing must pause before the title is matched. */
export const SIMILAR_DEBOUNCE_MS = 350;

/** How many possible duplicates the strip lists at most. */
export const SIMILAR_LIMIT = 5;

const SEARCHABLE_WORD = /[A-Za-z0-9]{4,}/;

/** Whether a title holds a word the search index could have posted. */
export const isSearchableTitle = (title: string): boolean =>
  SEARCHABLE_WORD.test(title);

/**
 * The possible duplicates of a title, re-read one pause after it last
 * changed. A title with no searchable word shows none and sends no request,
 * and the last answer stays up while a newer pause is pending, so the strip
 * does not flicker on every keystroke.
 */
export const useSimilarIssues = (
  workspaceId: string,
  title: string
): SimilarIssueRead[] => {
  const [results, setResults] = useState<SimilarIssueRead[]>([]);
  const trimmed = title.trim();
  const searchable = isSearchableTitle(trimmed);

  useEffect(() => {
    if (!searchable) return;
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => {
      similarIssues(
        workspaceId,
        trimmed.slice(0, 128),
        { limit: SIMILAR_LIMIT },
        controller.signal
      )
        .then((found) => {
          if (!controller.signal.aborted) setResults(found);
        })
        .catch(() => {
          if (!controller.signal.aborted) setResults([]);
        });
    }, SIMILAR_DEBOUNCE_MS);
    return () => {
      globalThis.clearTimeout(timer);
      controller.abort();
    };
  }, [workspaceId, trimmed, searchable]);

  return searchable ? results : [];
};

/** The status a hit carries, in the shape the glyph resolves. */
const statusOf = (issue: SimilarIssueRead): StatusLike | undefined =>
  issue.status_category === null
    ? undefined
    : {
        id: issue.status_id,
        category: issue.status_category,
        color: issue.status_color,
        icon: issue.status_icon,
      };

/** Props for SimilarIssues. */
export interface SimilarIssuesProps {
  issues: SimilarIssueRead[];
  /** Builds the link a row opens, or null while the workspace slug is unknown. */
  hrefOf: (issue: SimilarIssueRead) => string | null;
  /** The issue the new one will be marked a duplicate of, if any. */
  duplicateOfId: string | null;
  onMarkDuplicate: (issue: SimilarIssueRead | null) => void;
}

/** A compact list of possible duplicates, each with open and mark actions. */
export const SimilarIssues: React.FC<SimilarIssuesProps> = ({
  issues,
  hrefOf,
  duplicateOfId,
  onMarkDuplicate,
}) => {
  if (issues.length === 0) return null;
  return (
    <section
      aria-label="Similar issues"
      className="rounded-md border border-line bg-raised/40"
    >
      <h3 className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium text-text-faint">
        Similar issues
      </h3>
      <ul className="pb-1">
        {issues.map((issue) => {
          const marked = issue.issue_id === duplicateOfId;
          const href = hrefOf(issue);
          const status = statusOf(issue);
          return (
            <li
              key={issue.issue_id}
              className={cn(
                'group flex h-7 items-center gap-2 px-2.5 text-xs',
                marked ? 'bg-accent-soft' : 'hover:bg-raised'
              )}
            >
              <StatusIcon
                status={status}
                {...(issue.status_name === null
                  ? {}
                  : { name: issue.status_name })}
              />
              <span className="w-14 shrink-0 truncate text-text-faint tabular-nums">
                {issue.key}
              </span>
              {href === null ? (
                <span className="min-w-0 flex-1 truncate text-text">
                  {issue.title}
                </span>
              ) : (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`Open ${issue.key} in a new tab`}
                  className="min-w-0 flex-1 truncate text-text hover:underline focus-visible:underline focus-visible:outline-none"
                >
                  {issue.title}
                </a>
              )}
              <button
                type="button"
                aria-pressed={marked}
                aria-label={
                  marked
                    ? `Unmark as duplicate of ${issue.key}`
                    : `Mark as duplicate of ${issue.key}`
                }
                onClick={() => {
                  onMarkDuplicate(marked ? null : issue);
                }}
                className={cn(
                  'shrink-0 rounded-sm px-1.5 py-0.5 text-[11px] transition-opacity duration-100',
                  marked
                    ? 'text-accent opacity-100'
                    : 'text-text-muted opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-line hover:text-text focus-visible:opacity-100'
                )}
              >
                {marked ? 'Duplicate' : 'Mark as duplicate'}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
};

export default SimilarIssues;
