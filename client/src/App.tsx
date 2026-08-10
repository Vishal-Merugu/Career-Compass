import { Navigate, Route, Routes } from 'react-router-dom';
import { DashboardLayout } from './components/DashboardLayout';
import { RequireAuth } from './auth/RequireAuth';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { ResultsPage } from './pages/ResultsPage';
import { RunsPage } from './pages/RunsPage';
import { RunDetailPage } from './pages/RunDetailPage';
import { CampaignsPage } from './pages/CampaignsPage';
import { CampaignDetailPage } from './pages/CampaignDetailPage';
import { SettingsPage } from './pages/SettingsPage';
import { SetupPage } from './pages/SetupPage';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />

      <Route element={<RequireAuth />}>
        <Route element={<DashboardLayout />}>
          <Route path="/runs" element={<RunsPage />} />
          <Route path="/runs/:id" element={<RunDetailPage />} />
          <Route path="/results" element={<ResultsPage />} />
          <Route path="/campaigns" element={<CampaignsPage />} />
          <Route path="/campaigns/:id" element={<CampaignDetailPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/setup" element={<SetupPage />} />
        </Route>
      </Route>

      {/* Express serves index.html for any non-/api path, so unknown routes
          reach the client rather than 404ing. Send them somewhere real. */}
      <Route path="*" element={<Navigate to="/results" replace />} />
    </Routes>
  );
}
