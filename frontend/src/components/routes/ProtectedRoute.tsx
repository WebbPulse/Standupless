/**
 * Guards routes that need a signed-in user.
 */

import React from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import Spinner from '../ui/spinner';

/**
 * Shows a spinner while the session has never settled, redirects to login when
 * no session is held, and renders the route otherwise. `isLoading` is true only
 * until the session first settles, so a token call made from inside the route
 * keeps the page mounted, and `isAuthenticated` stays true for the duration of
 * such a call, so neither branch fires mid-request.
 */
const ProtectedRoute: React.FC = () => {
  const { isAuthenticated, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return <Spinner />;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <Outlet />;
};

export default ProtectedRoute;
