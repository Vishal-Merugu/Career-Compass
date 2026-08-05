import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Divider,
  Group,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { IconAlertCircle, IconArrowRight, IconLock } from '@tabler/icons-react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { CompassMark, Wordmark } from '../components/Logo';
import classes from './LoginPage.module.css';

interface LocationState {
  from?: string;
}

const POINTS = [
  'Discover roles and decision-makers across your target companies',
  'Qualify every profile against your context before you reach out',
  'Track outreach, limits and daily activity in one place',
];

export function LoginPage() {
  const { user, isLoading, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const form = useForm({
    initialValues: { email: '', password: '' },
    validate: {
      email: (v) => (/^\S+@\S+\.\S+$/.test(v) ? null : 'Enter a valid email'),
      // Matches the server's zod schema in `server/src/auth/routes.ts`.
      password: (v) =>
        v.length >= 8 ? null : 'Password must be at least 8 characters',
    },
  });

  // Already signed in — nothing to do here.
  if (!isLoading && user) {
    return <Navigate to="/results" replace />;
  }

  const handleSubmit = form.onSubmit(async ({ email, password }) => {
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      const from = (location.state as LocationState | null)?.from;
      navigate(from ?? '/results', { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Something went wrong. Retry.',
      );
    } finally {
      setSubmitting(false);
    }
  });

  return (
    <div className={classes.root}>
      <aside className={classes.brand}>
        <div className={classes.brandContent}>
          <Wordmark size={30} />
        </div>

        <div className={classes.brandContent}>
          <Title
            order={1}
            fz={38}
            fw={620}
            c="#f4f4f5"
            style={{ letterSpacing: '-0.028em', lineHeight: 1.15 }}
          >
            Every conversation
            <br />
            starts with the right
            <br />
            person.
          </Title>

          <ul className={classes.pointList} style={{ marginTop: 28 }}>
            {POINTS.map((point) => (
              <li key={point} className={classes.point}>
                <span className={classes.pointDot} />
                {point}
              </li>
            ))}
          </ul>
        </div>

        <Text
          className={classes.brandContent}
          fz={12.5}
          c="rgba(244,244,245,0.42)"
        >
          Reachable on the university network only.
        </Text>
      </aside>

      <main className={classes.form}>
        <div className={classes.formInner}>
          <Stack gap={0} mb="xl">
            {/* The mark repeats here for the narrow layout, where the brand
                panel is hidden entirely. */}
            <Box hiddenFrom="lg" mb="lg">
              <Wordmark size={28} />
            </Box>
            <Title order={2} fz={26}>
              Sign in
            </Title>
            <Text c="dimmed" size="sm" mt={6}>
              Use the credentials you registered with the server.
            </Text>
          </Stack>

          <form onSubmit={handleSubmit} noValidate>
            <Stack gap="md">
              {error && (
                <Alert
                  color="red"
                  variant="light"
                  radius="md"
                  icon={<IconAlertCircle size={17} />}
                >
                  {error}
                </Alert>
              )}

              <TextInput
                label="Email"
                placeholder="you@example.com"
                type="email"
                autoComplete="username"
                size="md"
                {...form.getInputProps('email')}
              />

              {/* No placeholder: a row of bullets in an empty password field
                  is indistinguishable from a filled one. */}
              <PasswordInput
                label="Password"
                autoComplete="current-password"
                size="md"
                {...form.getInputProps('password')}
              />

              <Button
                type="submit"
                loading={submitting}
                size="md"
                fullWidth
                mt={4}
                rightSection={!submitting && <IconArrowRight size={17} />}
              >
                Sign in
              </Button>
            </Stack>
          </form>

          <Divider my="xl" />

          <Group gap={9} wrap="nowrap" align="flex-start">
            <Box c="dimmed" mt={2}>
              <IconLock size={15} />
            </Box>
            <Text c="dimmed" fz={12.5} lh={1.5}>
              Your session is held in a secure, httpOnly cookie. The Chrome
              extension authenticates separately with its own API key — signing
              out here does not disconnect it.
            </Text>
          </Group>

          <Box hiddenFrom="lg" mt="xl" ta="center" c="dimmed">
            <Group justify="center" gap={7}>
              <CompassMark size={14} />
              <Text fz={12}>University network only</Text>
            </Group>
          </Box>
        </div>
      </main>
    </div>
  );
}
