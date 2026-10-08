/**
 * The route table. `/` is the public home page, which forwards a signed in
 * visitor to their workspaces. Guest routes sit behind `GuestRoute`, the authenticated
 * pages behind `ProtectedRoute`, and everything under `/w/:slug` behind the
 * workspace provider that resolves the slug.
 *
 * `/admin/github-app` is the platform admin's GitHub App page. It sits behind
 * `ProtectedRoute` like any signed in page, and the API answers anyone who is
 * not a platform admin with the same 404 as a path this application does not
 * serve, which the page renders as not found.
 *
 * `/shared/:token` sits outside both, because a reader holding a share token
 * has no session to protect and no workspace slug to resolve. Putting it inside
 * either would make an anonymous read depend on who was asking.
 *
 * Every page under `/w/:slug` sits inside the pathless `WorkspaceLayout`
 * route, which holds what must outlive a page change: the shortcut registry,
 * the command palette, the peek pane and the create dialogs.
 *
 * `/privacy`, `/terms`, `/refunds`, `/pricing` and `/contact` also sit
 * outside both, so the same pages answer a visitor, someone signing up and a
 * signed in member. The build prerenders them, and `/`, into static HTML.
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
import GithubApp from './pages/admin/GithubApp';
import GithubAppCreated from './pages/admin/GithubAppCreated';
import Board from './pages/board/Board';
import CycleDetail from './pages/planning/CycleDetail';
import Cycles from './pages/planning/Cycles';
import Standup from './pages/teams/Standup';
import InitiativeDetail from './pages/planning/InitiativeDetail';
import Initiatives from './pages/planning/Initiatives';
import ProjectDetail from './pages/planning/ProjectDetail';
import Projects from './pages/planning/Projects';
import Roadmap from './pages/planning/Roadmap';
import ReleaseDetail from './pages/releases/ReleaseDetail';
import Releases from './pages/releases/Releases';
import Inbox from './pages/inbox/Inbox';
import Landing from './pages/landing/Landing';
import Privacy from './pages/legal/Privacy';
import Refunds from './pages/legal/Refunds';
import Terms from './pages/legal/Terms';
import Contact from './pages/contact/Contact';
import Pricing from './pages/pricing/Pricing';
import IssueDetail from './pages/issues/IssueDetail';
import MyIssues from './pages/issues/MyIssues';
import NotFound from './pages/NotFound';
import AccountDeleted from './pages/authentication/AccountDeleted';
import {
  ACCOUNT_DELETED_PATH,
  CONTACT_PATH,
  PRICING_PATH,
  PRIVACY_PATH,
  REFUNDS_PATH,
  TERMS_PATH,
} from './lib/paths';
import Team from './pages/teams/Team';
import TeamArchive from './pages/teams/TeamArchive';
import TeamTriage from './pages/teams/TeamTriage';
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
import BillingSettings from './pages/workspaces/BillingSettings';
import ConnectedAppsSettings from './pages/workspaces/ConnectedAppsSettings';
import McpAndCliSettings from './pages/workspaces/McpAndCliSettings';
import NotificationsSettings from './pages/workspaces/NotificationsSettings';
import ShareLinksSettings from './pages/workspaces/ShareLinksSettings';
import ExportSettings from './pages/workspaces/ExportSettings';
import SecuritySettings from './pages/workspaces/SecuritySettings';
import WorkspaceLabelsSettings from './pages/workspaces/WorkspaceLabelsSettings';
import WorkspaceWorkflowSettings from './pages/workspaces/WorkspaceWorkflowSettings';
import TeamsSettings from './pages/workspaces/TeamsSettings';

/** Maps every path this application serves onto its page. */
const App: React.FC = () => (
  <Routes>
    <Route path="/" element={<Landing />} />
    <Route path={PRIVACY_PATH} element={<Privacy />} />
    <Route path={TERMS_PATH} element={<Terms />} />
    <Route path={REFUNDS_PATH} element={<Refunds />} />
    <Route path={PRICING_PATH} element={<Pricing />} />
    <Route path={CONTACT_PATH} element={<Contact />} />
    <Route path={ACCOUNT_DELETED_PATH} element={<AccountDeleted />} />

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
      <Route path="/admin/github-app" element={<GithubApp />} />
      <Route path="/admin/github-app/created" element={<GithubAppCreated />} />

      <Route path="/w/:slug" element={<WorkspaceProvider />}>
        <Route element={<WorkspaceLayout />}>
          <Route index element={<WorkspaceHome />} />

          <Route path="settings" element={<WorkspaceSettings />} />
          <Route path="settings/teams" element={<TeamsSettings />} />
          <Route
            path="settings/workflow"
            element={<WorkspaceWorkflowSettings />}
          />
          <Route path="settings/labels" element={<WorkspaceLabelsSettings />} />
          <Route path="settings/billing" element={<BillingSettings />} />
          <Route path="settings/api-keys" element={<ApiKeysSettings />} />
          <Route
            path="settings/connected-apps"
            element={<ConnectedAppsSettings />}
          />
          <Route path="settings/mcp-and-cli" element={<McpAndCliSettings />} />
          <Route path="settings/share-links" element={<ShareLinksSettings />} />
          <Route path="settings/export" element={<ExportSettings />} />
          <Route path="settings/security" element={<SecuritySettings />} />
          <Route
            path="settings/notifications"
            element={<NotificationsSettings />}
          />

          <Route path="team/:keyPrefix" element={<Team />} />
          <Route path="team/:keyPrefix/board" element={<Board />} />
          <Route path="team/:keyPrefix/archive" element={<TeamArchive />} />
          <Route path="team/:keyPrefix/triage" element={<TeamTriage />} />
          <Route path="team/:keyPrefix/cycles" element={<Cycles />} />
          <Route
            path="team/:keyPrefix/cycles/:cycleId"
            element={<CycleDetail />}
          />
          <Route path="team/:keyPrefix/releases" element={<Releases />} />
          <Route
            path="team/:keyPrefix/releases/:releaseId"
            element={<ReleaseDetail />}
          />
          <Route path="team/:keyPrefix/standup" element={<Standup />} />
          <Route path="team/:keyPrefix/settings" element={<TeamSettings />} />

          <Route path="projects" element={<Projects />} />
          <Route path="projects/:id" element={<ProjectDetail />} />
          <Route path="initiatives" element={<Initiatives />} />
          <Route path="initiatives/:id" element={<InitiativeDetail />} />

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
