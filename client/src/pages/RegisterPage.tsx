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
import { IconAlertCircle, IconArrowRight, IconKey } from '@tabler/icons-react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { AuthShell } from '../components/AuthShell';

export function RegisterPage() {
  const { user, isLoading, register } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const form = useForm({
    initialValues: { email: '', password: '', registrationToken: '' },
    validate: {
      email: (v) => (/^\S+@\S+\.\S+$/.test(v) ? null : 'Enter a valid email'),
      // Mirrors the server's zod schema in `server/src/auth/routes.ts`.
      password: (v) =>
        v.length >= 8 ? null : 'Password must be at least 8 characters',
    },
  });

  if (!isLoading && user) {
    return <Navigate to="/results" replace />;
  }

  const handleSubmit = form.onSubmit(
    async ({ email, password, registrationToken }) => {
      setError(null);
      setSubmitting(true);
      try {
        await register(email, password, registrationToken);
        // Registering signs you in; the server set the session cookie.
        navigate('/results', { replace: true });
      } catch (err) {
        setError(
          err instanceof ApiError
            ? err.message
            : 'Something went wrong. Retry.',
        );
      } finally {
        setSubmitting(false);
      }
    },
  );

  return (
    <AuthShell
      title="Create an account"
      subtitle="Sets up your workspace on this server."
      footnote={
        <>
          <Divider my="xl" />
          <Group gap={9} wrap="nowrap" align="flex-start">
            <Box c="dimmed" mt={2}>
              <IconKey size={15} />
            </Box>
            <Text c="dimmed" fz={12.5} lh={1.5}>
              The first account on a new server is created without an invite
              code. After that, one is required — ask whoever runs this instance
              for the value of <code>REGISTRATION_TOKEN</code>.
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

          <PasswordInput
            label="Password"
            description="At least 8 characters"
            autoComplete="new-password"
            size="md"
            {...form.getInputProps('password')}
          />

          {/* Always shown rather than revealed after a failed attempt: a field
              that appears only once you have been rejected reads as a trick. */}
          <TextInput
            label="Invite code"
            placeholder="Leave blank on a new server"
            autoComplete="off"
            size="md"
            {...form.getInputProps('registrationToken')}
          />

          <Button
            type="submit"
            loading={submitting}
            size="md"
            fullWidth
            mt={4}
            rightSection={!submitting && <IconArrowRight size={17} />}
          >
            Create account
          </Button>

          <Text c="dimmed" fz={13} ta="center">
            Already have an account?{' '}
            <Anchor component={Link} to="/login" fz={13}>
              Sign in
            </Anchor>
          </Text>
        </Stack>
      </form>
    </AuthShell>
  );
}
