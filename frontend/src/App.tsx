/**
 * The route table. Guest routes sit behind `GuestRoute` and the authenticated
 * pages behind `ProtectedRoute`.
 */

import React from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import GuestRoute from './components/routes/GuestRoute';
import ProtectedRoute from './components/routes/ProtectedRoute';
import ForgotPassword from './pages/authentication/ForgotPassword';
import Login from './pages/authentication/Login';
import Register from './pages/authentication/Register';
import ResetPassword from './pages/authentication/ResetPassword';
import Security from './pages/authentication/Security';
import VerifyEmail from './pages/authentication/VerifyEmail';
import NotFound from './pages/NotFound';
import Workspaces from './pages/workspaces/Workspaces';

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

    <Route element={<ProtectedRoute />}>
      <Route path="/workspaces" element={<Workspaces />} />
      <Route path="/security" element={<Security />} />
    </Route>

    <Route path="*" element={<NotFound />} />
  </Routes>
);

export default App;
