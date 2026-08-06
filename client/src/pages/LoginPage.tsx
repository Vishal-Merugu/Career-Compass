import { useState } from 'react';
import {
  Alert,
  Anchor,
  Box,
  Button,
  Divider,
  Group,
  PasswordInput,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { IconAlertCircle, IconArrowRight, IconLock } from '@tabler/icons-react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { AuthShell } from '../components/AuthShell';

interface LocationState {
  from?: string;
}

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
    <AuthShell
      title="Sign in"
      subtitle="Use the credentials you registered with the server."
      footnote={
        <>
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
        </>
      }
    >
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

          {/* No placeholder: a row of bullets in an empty password field is
              indistinguishable from a filled one. */}
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

          <Text c="dimmed" fz={13} ta="center">
            No account yet?{' '}
            <Anchor component={Link} to="/register" fz={13}>
              Create one
            </Anchor>
          </Text>
        </Stack>
      </form>
    </AuthShell>
  );
}
