/**
 * A person's avatar or name as a link to their member page. Outside a
 * workspace or a router, or with no person, it renders its content as is, so
 * a component that names people works the same in a test or a preview.
 */

import React, { useContext } from 'react';
import { Link, useInRouterContext } from 'react-router-dom';
import { WorkspaceContext } from '../../contexts/WorkspaceContextDefinition';
import { cn } from '../../lib/cn';
import { memberPath } from '../../lib/paths';

/** Props for MemberLink: the person and what stands for them. */
export interface MemberLinkProps {
  userId: string | null | undefined;
  children: React.ReactNode;
  className?: string;
  /** The accessible name, when the content is only an avatar. */
  label?: string;
}

/** Links its content to the member page of `userId`. */
export const MemberLink: React.FC<MemberLinkProps> = ({
  userId,
  children,
  className,
  label,
}) => {
  const workspace = useContext(WorkspaceContext)?.workspace ?? null;
  const routed = useInRouterContext();
  if (
    !routed ||
    workspace === null ||
    userId === null ||
    userId === undefined ||
    userId === ''
  ) {
    return <span className={className}>{children}</span>;
  }
  return (
    <Link
      to={memberPath(workspace.slug, userId)}
      {...(label === undefined ? {} : { 'aria-label': label, title: label })}
      className={cn(
        'rounded-sm hover:underline focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none',
        className
      )}
      onClick={(event) => {
        event.stopPropagation();
      }}
    >
      {children}
    </Link>
  );
};

export default MemberLink;
