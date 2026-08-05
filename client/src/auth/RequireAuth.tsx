import { Center, Stack, Text } from '@mantine/core';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { CompassMark } from '../components/Logo';
import { useAuth } from './AuthProvider';
import classes from './RequireAuth.module.css';

/**
 * Route guard. Blocks render until `GET /api/auth/me` has resolved, so a
 * signed-in user reloading a deep link never flashes the login screen.
 */
export function RequireAuth() {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    // The mark pulsing reads as "starting up"; a bare spinner reads as "stuck".
    return (
      <Center h="100vh">
        <Stack align="center" gap="xs">
          <div className={classes.pulse}>
            <CompassMark size={30} />
          </div>
          <Text fz={12.5} c="dimmed">
            Restoring your session…
          </Text>
        </Stack>
      </Center>
    );
  }

  if (!user) {
    // `state.from` lets the login screen send the user back where they aimed.
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <Outlet />;
}
