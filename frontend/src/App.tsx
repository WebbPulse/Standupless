/**
 * The route table. `/` is the public home page, which forwards a signed in
 * visitor to their workspaces. Guest routes sit behind `GuestRoute`, the authenticated
 * pages behind `ProtectedRoute`, and everything under `/w/:slug` behind the
 * workspace provider that resolves the slug.
 *
 * `/shared/:token` sits outside both, because a reader holding a share token
 * has no session to protect and no workspace slug to resolve. Putting it inside
 * either would make an anonymous read depend on who was asking.
 *
 * Every page under `/w/:slug` sits inside the pathless `WorkspaceLayout`
 * route, which holds what must outlive a page change: the shortcut registry,
 * the command palette, the peek pane and the create dialogs.
 *
 * The `p/:keyPrefix` paths were what teams lived under before they were called
 * teams. They stay as redirects rather than being removed, because they are in
 * bookmarks and in links people have already sent each other.
 */

import React from 'react';
import { Route, Routes } from 'react-router-dom';
import GuestRoute from './components/routes/GuestRoute';
import ProtectedRoute from './components/routes/ProtectedRoute';
import LegacyTeamRedirect from './components/routes/LegacyTeamRedirect';
import WorkspaceLayout from './components/workspace/WorkspaceLayout';
import WorkspaceProvider from './contexts/WorkspaceContext';
import AcceptInvite from './pages/invites/AcceptInvite';
import ForgotPassword from './pages/authentication/ForgotPassword';
import Login from './pages/authentication/Login';
import Register from './pages/authentication/Register';
import ResetPassword from './pages/authentication/ResetPassword';
import Security from './pages/authentication/Security';
import VerifyEmail from './pages/authentication/VerifyEmail';
import Board from './pages/board/Board';
import CycleDetail from './pages/planning/CycleDetail';
import Cycles from './pages/planning/Cycles';
import ProjectDetail from './pages/planning/ProjectDetail';
import Projects from './pages/planning/Projects';
import Roadmap from './pages/planning/Roadmap';
import Inbox from './pages/inbox/Inbox';
import Landing from './pages/landing/Landing';
import IssueDetail from './pages/issues/IssueDetail';
import MyIssues from './pages/issues/MyIssues';
import NotFound from './pages/NotFound';
import Team from './pages/teams/Team';
import TeamSettings from './pages/teams/TeamSettings';
import Search from './pages/search/Search';
import SharedView from './pages/shared/SharedView';
import ViewDetail from './pages/views/ViewDetail';
import Views from './pages/views/Views';
import CreateWorkspace from './pages/workspaces/CreateWorkspace';
import WorkspaceHome from './pages/workspaces/WorkspaceHome';
import Workspaces from './pages/workspaces/Workspaces';
import WorkspaceSettings from './pages/workspaces/WorkspaceSettings';
import ApiKeysSettings from './pages/workspaces/ApiKeysSettings';
import ShareLinksSettings from './pages/workspaces/ShareLinksSettings';
import TeamsSettings from './pages/workspaces/TeamsSettings';

/** Maps every path this application serves onto its page. */
const App: React.FC = () => (
  <Routes>
    <Route path="/" element={<Landing />} />

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
      <Route path="/workspaces/new" element={<CreateWorkspace />} />
      <Route path="/security" element={<Security />} />

      <Route path="/w/:slug" element={<WorkspaceProvider />}>
        <Route element={<WorkspaceLayout />}>
          <Route index element={<WorkspaceHome />} />

          <Route path="settings" element={<WorkspaceSettings />} />
          <Route path="settings/teams" element={<TeamsSettings />} />
          <Route path="settings/api-keys" element={<ApiKeysSettings />} />
          <Route path="settings/share-links" element={<ShareLinksSettings />} />

          <Route path="team/:keyPrefix" element={<Team />} />
          <Route path="team/:keyPrefix/board" element={<Board />} />
          <Route path="team/:keyPrefix/cycles" element={<Cycles />} />
          <Route
            path="team/:keyPrefix/cycles/:cycleId"
            element={<CycleDetail />}
          />
          <Route path="team/:keyPrefix/settings" element={<TeamSettings />} />

          <Route path="projects" element={<Projects />} />
          <Route path="projects/:id" element={<ProjectDetail />} />

          <Route path="issues" element={<MyIssues />} />
          <Route path="issues/:key" element={<IssueDetail />} />
          <Route path="search" element={<Search />} />
          <Route path="inbox" element={<Inbox />} />
          <Route path="roadmap" element={<Roadmap />} />
          <Route path="views" element={<Views />} />
          <Route path="views/:viewId" element={<ViewDetail />} />

          <Route path="p/:keyPrefix" element={<LegacyTeamRedirect />} />
          <Route
            path="p/:keyPrefix/board"
            element={<LegacyTeamRedirect to="board" />}
          />
          <Route
            path="p/:keyPrefix/cycles"
            element={<LegacyTeamRedirect to="cycles" />}
          />
          <Route
            path="p/:keyPrefix/milestones"
            element={<LegacyTeamRedirect to="projects" />}
          />
        </Route>
      </Route>
    </Route>

    <Route path="*" element={<NotFound />} />
  </Routes>
);

export default App;
