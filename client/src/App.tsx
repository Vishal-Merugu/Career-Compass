import { Navigate, Route, Routes } from 'react-router-dom';
import { DashboardLayout } from './components/DashboardLayout';
import { RequireAuth } from './auth/RequireAuth';
import { LoginPage } from './pages/LoginPage';
import { ResultsPage } from './pages/ResultsPage';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />

      <Route element={<RequireAuth />}>
        <Route element={<DashboardLayout />}>
          <Route path="/results" element={<ResultsPage />} />
        </Route>
      </Route>

      {/* Express serves index.html for any non-/api path, so unknown routes
          reach the client rather than 404ing. Send them somewhere real. */}
      <Route path="*" element={<Navigate to="/results" replace />} />
    </Routes>
  );
}
