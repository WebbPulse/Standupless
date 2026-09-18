/**
 * The route table. Guest routes sit behind `GuestRoute`, the authenticated
 * pages behind `ProtectedRoute`, and everything under `/w/:slug` behind the
 * workspace provider that resolves the slug.
 */

import React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import GuestRoute from './components/routes/GuestRoute';
import ProtectedRoute from './components/routes/ProtectedRoute';
import WorkspaceProvider from './contexts/WorkspaceContext';
import AcceptInvite from './pages/invites/AcceptInvite';
import ForgotPassword from './pages/authentication/ForgotPassword';
import Login from './pages/authentication/Login';
import Register from './pages/authentication/Register';
import ResetPassword from './pages/authentication/ResetPassword';
import Security from './pages/authentication/Security';
import VerifyEmail from './pages/authentication/VerifyEmail';
import IssueDetail from './pages/issues/IssueDetail';
import MyIssues from './pages/issues/MyIssues';
import NotFound from './pages/NotFound';
import Project from './pages/projects/Project';
import WorkspaceHome from './pages/workspaces/WorkspaceHome';
import Workspaces from './pages/workspaces/Workspaces';
import WorkspaceSettings from './pages/workspaces/WorkspaceSettings';

/** Maps every path this application serves onto its page. */
const App: React.FC = () => (
  <Routes>
    <Route path="/" element={<Navigate to="/workspaces" replace />} />

    <Route element={<GuestRoute />}>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
    </Route>

    <Route path="/verify-email" element={<VerifyEmail />} />
    <Route path="/invites/accept" element={<AcceptInvite />} />

    <Route element={<ProtectedRoute />}>
      <Route path="/workspaces" element={<Workspaces />} />
      <Route path="/security" element={<Security />} />

      <Route path="/w/:slug" element={<WorkspaceProvider />}>
        <Route index element={<WorkspaceHome />} />
        <Route path="settings" element={<WorkspaceSettings />} />
        <Route path="p/:keyPrefix" element={<Project />} />
        <Route path="issues" element={<MyIssues />} />
        <Route path="issues/:key" element={<IssueDetail />} />
      </Route>
    </Route>

    <Route path="*" element={<NotFound />} />
  </Routes>
);

export default App;
