import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Badge,
  Box,
  Button,
  Divider,
  FileButton,
  Group,
  PasswordInput,
  Skeleton,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
} from '@mantine/core';
import {
  IconAlertCircle,
  IconCheck,
  IconFileTypePdf,
  IconPlugConnected,
  IconTrash,
  IconUpload,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import type {
  OutreachSettings,
  OutreachSettingsResponse,
  VerifyResponse,
} from '../api/types';

const SETTINGS_KEY = ['outreach-settings'];

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Box>
      <Text fw={600} fz={15}>
        {title}
      </Text>
      <Text c="dimmed" fz={13.5} mt={2} mb="md">
        {description}
      </Text>
      {children}
    </Box>
  );
}

export function SettingsPage() {
  const queryClient = useQueryClient();

  const { data, isPending, error } = useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => api.get<OutreachSettingsResponse>('/api/settings/outreach'),
  });

  const settings = data?.settings;

  const [smtpUser, setSmtpUser] = useState('');
  const [smtpFromName, setSmtpFromName] = useState('');
  const [emailSignature, setEmailSignature] = useState('');
  // Empty means "leave unchanged". The server never sends the stored value
  // back, so there is nothing to prefill and nothing to accidentally resubmit.
  const [password, setPassword] = useState('');
  const [verifyResult, setVerifyResult] = useState<VerifyResponse | null>(null);
  const resetFileRef = useRef<() => void>(null);

  // Seed the form once the first load lands. Keyed on the fetched values, not
  // on `isPending`, so a background refetch cannot clobber an in-progress edit.
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (!settings || seeded) return;
    setSmtpUser(settings.smtpUser ?? '');
    setSmtpFromName(settings.smtpFromName ?? '');
    setEmailSignature(settings.emailSignature ?? '');
    setSeeded(true);
  }, [settings, seeded]);

  const applySettings = (next: OutreachSettings) => {
    queryClient.setQueryData<OutreachSettingsResponse>(SETTINGS_KEY, {
      ok: true,
      settings: next,
    });
  };

  const save = useMutation({
    mutationFn: () =>
      api.put<OutreachSettingsResponse>('/api/settings/outreach', {
        smtpUser: smtpUser.trim() || null,
        smtpFromName: smtpFromName.trim() || null,
        emailSignature: emailSignature.trim() || null,
        // Omitted entirely when blank — `undefined` is what the server reads
        // as "keep the existing password".
        ...(password ? { smtpPassword: password } : {}),
      }),
    onSuccess: (res) => {
      applySettings(res.settings);
      setPassword('');
      setVerifyResult(null);
    },
  });

  const verify = useMutation({
    mutationFn: () => api.post<VerifyResponse>('/api/settings/outreach/verify'),
    onSuccess: (res) => setVerifyResult(res),
  });

  const uploadResume = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('resume', file);
      return api.upload<OutreachSettingsResponse>(
        '/api/settings/outreach/resume',
        form,
      );
    },
    onSuccess: (res) => {
      applySettings(res.settings);
      resetFileRef.current?.();
    },
  });

  const removeResume = useMutation({
    mutationFn: () =>
      api.del<OutreachSettingsResponse>('/api/settings/outreach/resume'),
    onSuccess: (res) => applySettings(res.settings),
  });

  if (error) {
    return (
      <Alert
        color="red"
        variant="light"
        radius="lg"
        icon={<IconAlertCircle size={18} />}
        title="Could not load settings"
      >
        {error.message}
      </Alert>
    );
  }

  const mutationError = [save.error, uploadResume.error, removeResume.error]
    .filter((e): e is Error => e instanceof Error)
    .at(0);

  return (
    <Stack gap="xl" maw={720}>
      <Box>
        <Title order={2}>Settings</Title>
        <Text c="dimmed" fz={14} mt={4}>
          How outreach emails are sent and signed.
        </Text>
      </Box>

      {mutationError && (
        <Alert
          color="red"
          variant="light"
          radius="lg"
          icon={<IconAlertCircle size={18} />}
        >
          {mutationError instanceof ApiError
            ? mutationError.message
            : 'Something went wrong'}
        </Alert>
      )}

      {isPending ? (
        <Stack gap="md">
          <Skeleton height={38} radius="md" />
          <Skeleton height={38} radius="md" />
          <Skeleton height={90} radius="md" />
        </Stack>
      ) : (
        <>
          <Section
            title="Sending address"
            description="A Gmail account and an app password — not your normal password. Create one at myaccount.google.com → Security → App passwords."
          >
            <Stack gap="md">
              <TextInput
                label="Gmail address"
                placeholder="you@gmail.com"
                value={smtpUser}
                onChange={(e) => setSmtpUser(e.currentTarget.value)}
              />
              <PasswordInput
                label="App password"
                description={
                  settings?.smtpConfigured
                    ? 'A password is saved. Leave blank to keep it, or type a new one to replace it.'
                    : '16 characters, shown once by Google when you create it.'
                }
                placeholder={
                  settings?.smtpConfigured
                    ? '••••••••••••••••'
                    : 'abcd efgh ijkl mnop'
                }
                value={password}
                onChange={(e) => setPassword(e.currentTarget.value)}
              />
              <TextInput
                label="Sender name"
                description="What recipients see instead of the bare address."
                placeholder="Your Name"
                value={smtpFromName}
                onChange={(e) => setSmtpFromName(e.currentTarget.value)}
              />

              <Group gap="sm">
                <Button
                  onClick={() => save.mutate()}
                  loading={save.isPending}
                  disabled={!smtpUser.trim()}
                >
                  Save
                </Button>
                <Button
                  variant="default"
                  leftSection={<IconPlugConnected size={15} />}
                  onClick={() => verify.mutate()}
                  loading={verify.isPending}
                  disabled={!settings?.smtpConfigured}
                >
                  Test connection
                </Button>
                {settings?.smtpConfigured && (
                  <Badge color="gray" variant="light" size="sm">
                    configured
                  </Badge>
                )}
              </Group>

              {verifyResult &&
                (verifyResult.verified ? (
                  <Alert
                    color="teal"
                    variant="light"
                    radius="md"
                    icon={<IconCheck size={17} />}
                  >
                    Signed in to Gmail successfully.
                  </Alert>
                ) : (
                  <Alert
                    color="red"
                    variant="light"
                    radius="md"
                    icon={<IconAlertCircle size={17} />}
                    title="Gmail rejected these credentials"
                  >
                    <Text fz={13}>{verifyResult.error}</Text>
                    <Text fz={13} mt={6} c="dimmed">
                      An ordinary account password will not work here — it has
                      to be an app password.
                    </Text>
                  </Alert>
                ))}
            </Stack>
          </Section>

          <Divider />

          <Section
            title="Signature"
            description="Appended to the end of every generated email. The model is told not to write its own sign-off."
          >
            <Textarea
              autosize
              minRows={4}
              maxRows={10}
              placeholder={'Best,\nYour Name\nyou@example.com | +49 …'}
              value={emailSignature}
              onChange={(e) => setEmailSignature(e.currentTarget.value)}
            />
            <Button
              mt="md"
              onClick={() => save.mutate()}
              loading={save.isPending}
            >
              Save
            </Button>
          </Section>

          <Divider />

          <Section
            title="Résumé"
            description="Attached to every email in every campaign. PDF, up to 5 MB."
          >
            {settings?.resumeFileName ? (
              <Group gap="sm">
                <IconFileTypePdf size={20} opacity={0.6} />
                <Text fz={14} style={{ flex: 1 }} truncate>
                  {settings.resumeFileName}
                </Text>
                <FileButton
                  resetRef={resetFileRef}
                  accept="application/pdf"
                  onChange={(file) => file && uploadResume.mutate(file)}
                >
                  {(props) => (
                    <Button
                      {...props}
                      variant="default"
                      size="xs"
                      loading={uploadResume.isPending}
                    >
                      Replace
                    </Button>
                  )}
                </FileButton>
                <Button
                  variant="subtle"
                  color="red"
                  size="xs"
                  leftSection={<IconTrash size={14} />}
                  onClick={() => removeResume.mutate()}
                  loading={removeResume.isPending}
                >
                  Remove
                </Button>
              </Group>
            ) : (
              <FileButton
                resetRef={resetFileRef}
                accept="application/pdf"
                onChange={(file) => file && uploadResume.mutate(file)}
              >
                {(props) => (
                  <Button
                    {...props}
                    variant="default"
                    leftSection={<IconUpload size={15} />}
                    loading={uploadResume.isPending}
                  >
                    Upload a PDF
                  </Button>
                )}
              </FileButton>
            )}
          </Section>
        </>
      )}
    </Stack>
  );
}
