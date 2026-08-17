/**
 * One person, in full.
 *
 * The table can only show five columns, and the most interesting thing about a
 * qualified profile — *why* the model qualified them — did not fit in any of
 * them. It was written to the database at decision time and then never shown
 * anywhere, which made the qualification look arbitrary.
 *
 * A drawer rather than a modal: it does not black out the table behind it, so
 * you can keep your place while reading down a list of people.
 */

import {
  Anchor,
  Badge,
  Box,
  Button,
  Divider,
  Drawer,
  Group,
  Stack,
  Text,
} from '@mantine/core';
import { IconExternalLink, IconTrash } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import type { Profile, ProfileDetailResponse } from '../api/types';

const SOURCE_LABEL: Record<string, { label: string; color: string }> = {
  anymailfinder: { label: 'verified', color: 'teal' },
  anymailfinder_web: { label: 'verified', color: 'teal' },
  smtp_verified: { label: 'verified', color: 'teal' },
  mailmeteor: { label: 'from provider', color: 'blue' },
  pattern_guess: { label: 'guess', color: 'yellow' },
  not_found: { label: 'not found', color: 'gray' },
};

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Box>
      <Text fz={11.5} tt="uppercase" fw={600} c="dimmed" mb={3}>
        {label}
      </Text>
      {children}
    </Box>
  );
}

export function ProfileDrawer({
  profile,
  onClose,
  onDelete,
}: {
  profile: Profile | null;
  onClose: () => void;
  /**
   * Hand the person back to the page to delete.
   *
   * The drawer does not own the confirmation: the same dialog serves the
   * table's bulk action, and it is the page that knows whether the view is
   * scoped to one run — which changes what deleting even means.
   */
  onDelete?: (profile: Profile) => void;
}) {
  const source = profile?.emailSource
    ? (SOURCE_LABEL[profile.emailSource] ?? {
        label: profile.emailSource,
        color: 'gray',
      })
    : null;

  // `about` and the qualification reason are not in the list payload — shipping
  // `about` for every row took that response from 98 KB to 1.14 MB. Fetched
  // here, for one row, only while the drawer is open.
  const { data } = useQuery({
    queryKey: ['profile', profile?.id],
    queryFn: () =>
      api.get<ProfileDetailResponse>(`/api/profiles/${profile!.id}`),
    enabled: Boolean(profile),
  });

  const detail = data?.profile;

  return (
    <Drawer
      opened={Boolean(profile)}
      onClose={onClose}
      position="right"
      size="md"
      padding="lg"
      title={
        profile ? `${profile.firstName} ${profile.lastName}`.trim() : undefined
      }
    >
      {profile && (
        <Stack gap="lg">
          <Stack gap={6}>
            {profile.headline && <Text fz={14}>{profile.headline}</Text>}
            <Group gap={8}>
              {profile.company?.name && (
                <Badge variant="light" color="gray" size="sm">
                  {profile.company.name}
                </Badge>
              )}
              {profile.location && (
                <Text fz={12.5} c="dimmed">
                  {profile.location}
                </Text>
              )}
            </Group>
            {profile.linkedinUrl && (
              <Anchor
                href={profile.linkedinUrl}
                target="_blank"
                rel="noreferrer"
                fz={13}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
              >
                Open on LinkedIn <IconExternalLink size={13} />
              </Anchor>
            )}
          </Stack>

          <Divider />

          <Field label="Email">
            {profile.email ? (
              <Group gap="sm">
                <Anchor href={`mailto:${profile.email}`} fz={14}>
                  {profile.email}
                </Anchor>
                {source && (
                  <Badge size="xs" variant="light" color={source.color}>
                    {source.label}
                  </Badge>
                )}
              </Group>
            ) : (
              <Text fz={13.5} c="dimmed">
                Not looked up yet. Select the row and press “Find emails”.
              </Text>
            )}
          </Field>

          {detail?.qualificationReason && (
            <Field label="Why the model qualified them">
              <Text fz={13}>{detail.qualificationReason}</Text>
            </Field>
          )}

          {detail?.about && (
            <Field label="About">
              <Text fz={13} style={{ whiteSpace: 'pre-wrap' }} lineClamp={12}>
                {detail.about}
              </Text>
            </Field>
          )}

          <Group gap="xl">
            <Field label="Added">
              <Text fz={13}>
                {new Date(profile.createdAt).toLocaleString()}
              </Text>
            </Field>

            {detail?.searchJobId && (
              <Field label="Found by">
                <Anchor
                  component={Link}
                  to={`/runs/${detail.searchJobId}`}
                  fz={13}
                >
                  this run
                </Anchor>
              </Field>
            )}
          </Group>

          {onDelete && (
            <>
              <Divider />
              <Group justify="flex-start">
                <Button
                  variant="subtle"
                  color="red"
                  size="xs"
                  leftSection={<IconTrash size={14} />}
                  onClick={() => onDelete(profile)}
                >
                  Delete this profile
                </Button>
              </Group>
            </>
          )}
        </Stack>
      )}
    </Drawer>
  );
}
