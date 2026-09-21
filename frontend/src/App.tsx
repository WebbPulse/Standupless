/**
 * The route table. Guest routes sit behind `GuestRoute`, the authenticated
 * pages behind `ProtectedRoute`, and everything under `/w/:slug` behind the
 * workspace provider that resolves the slug.
 *
 * `/shared/:token` sits outside both, because a reader holding a share token
 * has no session to protect and no workspace slug to resolve. Putting it inside
 * either would make an anonymous read depend on who was asking.
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
import Board from './pages/board/Board';
import Cycles from './pages/planning/Cycles';
import Projects from './pages/planning/Projects';
import Roadmap from './pages/planning/Roadmap';
import Inbox from './pages/inbox/Inbox';
import IssueDetail from './pages/issues/IssueDetail';
import MyIssues from './pages/issues/MyIssues';
import NotFound from './pages/NotFound';
import Team from './pages/teams/Team';
import Search from './pages/search/Search';
import SharedView from './pages/shared/SharedView';
import WorkspaceHome from './pages/workspaces/WorkspaceHome';
import Workspaces from './pages/workspaces/Workspaces';
import WorkspaceSettings from './pages/workspaces/WorkspaceSettings';
import ApiKeysSettings from './pages/workspaces/ApiKeysSettings';
import ShareLinksSettings from './pages/workspaces/ShareLinksSettings';

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

    <Route path="/shared/:token" element={<SharedView />} />

    <Route path="/verify-email" element={<VerifyEmail />} />
    <Route path="/invites/accept" element={<AcceptInvite />} />

    <Route element={<ProtectedRoute />}>
      <Route path="/workspaces" element={<Workspaces />} />
      <Route path="/security" element={<Security />} />

      <Route path="/w/:slug" element={<WorkspaceProvider />}>
        <Route index element={<WorkspaceHome />} />
        <Route path="settings" element={<WorkspaceSettings />} />
        <Route path="settings/api-keys" element={<ApiKeysSettings />} />
        <Route path="settings/share-links" element={<ShareLinksSettings />} />
        <Route path="team/:keyPrefix" element={<Team />} />
        <Route path="team/:keyPrefix/board" element={<Board />} />
        <Route path="issues" element={<MyIssues />} />
        <Route path="issues/:key" element={<IssueDetail />} />
        <Route path="search" element={<Search />} />
        <Route path="inbox" element={<Inbox />} />
        <Route path="team/:keyPrefix/cycles" element={<Cycles />} />
        <Route path="team/:keyPrefix/projects" element={<Projects />} />
        <Route path="roadmap" element={<Roadmap />} />
      </Route>
    </Route>

    <Route path="*" element={<NotFound />} />
  </Routes>
);

export default App;
