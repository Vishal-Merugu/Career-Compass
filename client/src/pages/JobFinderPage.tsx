import { useState, useEffect } from 'react';
import {
  Badge,
  Box,
  Button,
  Card,
  Chip,
  Divider,
  Group,
  NumberInput,
  Paper,
  Progress,
  ScrollArea,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Text,
  Textarea,
  ThemeIcon,
  Title,
  Tooltip,
} from '@mantine/core';
import {
  IconBriefcase,
  IconCheck,
  IconClock,
  IconDatabase,
  IconDownload,
  IconExternalLink,
  IconEye,
  IconLanguage,
  IconMapPin,
  IconPlayerPlay,
  IconRefresh,
  IconSearch,
  IconX,
} from '@tabler/icons-react';
import { api } from '../api/client';

interface JobResult {
  jobId: string;
  title: string;
  company: string;
  location: string;
  url: string;
  postedDate: string;
  passed: boolean;
  fitScore: number;
  languageAssessment: string;
  reason: string;
  jdSnippet: string;
}

interface RunSummary {
  id: string;
  prompt: string;
  status: 'running' | 'completed' | 'paused' | 'error';
  targetCount: number;
  scannedCount: number;
  qualifiedCount: number;
  rejectedCount: number;
  createdAt: string;
  completedAt?: string;
  criteria: {
    keywords: string;
    location: string;
    targetCount: number;
    easyApplyOnly?: boolean;
    languageRule: {
      germanRequirement: string;
      explanation: string;
    };
  };
}

interface RunStatus extends RunSummary {
  jobs: JobResult[];
  errorMessage?: string;
}

const PRESET_PROMPTS = [
  'working student in Germany without German or German optional 20 jobs',
  'React developer in Berlin without German, Easy Apply, target 20',
  'Software Engineer intern in Germany, English only, need 20',
  'Python Backend Developer remote or Germany, German optional 20 jobs',
];

export function JobFinderPage() {
  const [prompt, setPrompt] = useState(PRESET_PROMPTS[0]);
  const [countOverride, setCountOverride] = useState<number | ''>(20);
  const [easyApplyOnly, setEasyApplyOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [runsList, setRunsList] = useState<RunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [runDetails, setRunDetails] = useState<RunStatus | null>(null);
  const [filterTab, setFilterTab] = useState<'passed' | 'all' | 'rejected'>(
    'passed',
  );
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);

  // Auto-toggle Easy Apply switch when user types "easy apply" in prompt
  const handlePromptChange = (val: string) => {
    setPrompt(val);
    const lower = val.toLowerCase();
    if (lower.includes('easy apply') || lower.includes('easy-apply')) {
      setEasyApplyOnly(true);
    }
  };

  // Fetch all runs
  const fetchRunsList = async () => {
    try {
      const res = await api.get<{ success: boolean; runs: RunSummary[] }>(
        '/api/easy-apply/runs',
      );
      if (res.success && res.runs) {
        setRunsList(res.runs);
      }
    } catch {
      // ignore
    }
  };

  // Poll runs list and active selected run
  useEffect(() => {
    fetchRunsList();
    const interval = setInterval(async () => {
      await fetchRunsList();

      // If a run is selected or running, fetch its full details
      if (selectedRunId) {
        try {
          const res = await api.get<{ success: boolean; run: RunStatus }>(
            `/api/easy-apply/runs/${selectedRunId}`,
          );
          if (res.success && res.run) {
            setRunDetails(res.run);
            if (res.run.status === 'completed' || res.run.status === 'error') {
              setLoading(false);
            }
          }
        } catch {
          // ignore
        }
      }
    }, 1500);

    return () => clearInterval(interval);
  }, [selectedRunId]);

  const handleStartSearch = async () => {
    if (!prompt.trim()) return;
    setLoading(true);
    try {
      const res = await api.post<{
        success: boolean;
        runId: string;
        targetCount: number;
      }>('/api/easy-apply/start', {
        prompt,
        countOverride: typeof countOverride === 'number' ? countOverride : 20,
        easyApplyOnly,
      });

      if (res.success && res.runId) {
        setSelectedRunId(res.runId);
        await fetchRunsList();
      }
    } catch (err: any) {
      setLoading(false);
      alert('Failed to start search: ' + (err.message || 'Unknown error'));
    }
  };

  const handleDownloadCsv = (runId: string) => {
    window.open(`/api/easy-apply/runs/${runId}/csv`, '_blank');
  };

  const displayedJobs = (runDetails?.jobs || []).filter((j) => {
    if (filterTab === 'passed') return j.passed;
    if (filterTab === 'rejected') return !j.passed;
    return true;
  });

  return (
    <Stack
      gap="lg"
      style={{ maxWidth: 1200, margin: '0 auto', paddingBottom: 60 }}
    >
      {/* Header */}
      <Group justify="space-between" align="flex-start">
        <Box>
          <Group gap="xs">
            <Title order={2}>AI Job Finder & Qualifier</Title>
            <Badge variant="light" color="blue" size="md">
              AI Powered
            </Badge>
          </Group>
          <Text c="dimmed" size="sm" mt={4}>
            Find matching jobs, inspect full Job Descriptions with AI, verify
            language requirements (e.g. without German or German optional), and
            save directly to database.
          </Text>
        </Box>
      </Group>

      {/* New Search Form Card */}
      <Paper p="md" radius="md" withBorder>
        <Stack gap="sm">
          <Text fw={600} size="sm">
            Search Criteria & Requirements (Natural Language)
          </Text>
          <Textarea
            placeholder="e.g. I need all jobs for React developer in Berlin without German or German optional, target 20 jobs"
            value={prompt}
            onChange={(e) => handlePromptChange(e.currentTarget.value)}
            minRows={3}
            maxRows={6}
            autosize
          />

          {/* Quick presets */}
          <Group gap="xs" mt={2}>
            <Text size="xs" c="dimmed">
              Suggestions:
            </Text>
            {PRESET_PROMPTS.map((preset, idx) => (
              <Chip
                key={idx}
                size="xs"
                variant="outline"
                checked={prompt === preset}
                onChange={() => handlePromptChange(preset)}
              >
                {preset.slice(0, 45)}...
              </Chip>
            ))}
          </Group>

          <Divider my="xs" />

          <Group justify="space-between">
            <Group gap="xl" align="center">
              <NumberInput
                label="Target Count (N)"
                description="Defaults to 20 if omitted"
                value={countOverride}
                onChange={(val) =>
                  setCountOverride(typeof val === 'number' ? val : '')
                }
                min={1}
                max={200}
                style={{ width: 160 }}
              />

              <Switch
                label="Easy Apply Only"
                description="Optional — toggle on if you only want Easy Apply"
                checked={easyApplyOnly}
                onChange={(e) => setEasyApplyOnly(e.currentTarget.checked)}
                mt={8}
              />
            </Group>

            <Button
              size="md"
              leftSection={
                loading ? (
                  <IconRefresh className="spin" size={18} />
                ) : (
                  <IconPlayerPlay size={18} />
                )
              }
              onClick={handleStartSearch}
              loading={loading}
              disabled={!prompt.trim()}
            >
              {loading ? 'Searching & Evaluating...' : 'Start New Search'}
            </Button>
          </Group>
        </Stack>
      </Paper>

      {/* Searches List Card */}
      <Paper p="md" radius="md" withBorder>
        <Group justify="space-between" mb="xs">
          <Group gap="xs">
            <IconBriefcase size={20} color="#228be6" />
            <Text fw={700} size="md">
              Searches & Discoveries ({runsList.length})
            </Text>
          </Group>
          <Text size="xs" c="dimmed">
            Live status · Click 'Download CSV' on any completed search
          </Text>
        </Group>

        {runsList.length === 0 ? (
          <Text c="dimmed" size="sm" ta="center" py="xl">
            No searches run yet. Enter your criteria above and click 'Start New
            Search'!
          </Text>
        ) : (
          <Table verticalSpacing="xs" highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Search Criteria / Prompt</Table.Th>
                <Table.Th style={{ width: 130 }}>Status</Table.Th>
                <Table.Th style={{ width: 150 }}>Progress</Table.Th>
                <Table.Th style={{ width: 120 }}>Started</Table.Th>
                <Table.Th style={{ width: 220, textAlign: 'right' }}>
                  Actions
                </Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {runsList.map((run) => {
                const isSelected = selectedRunId === run.id;
                const isRunning = run.status === 'running';
                const isCompleted = run.status === 'completed';
                const percent = Math.min(
                  100,
                  Math.round(
                    (run.qualifiedCount / (run.targetCount || 20)) * 100,
                  ),
                );

                return (
                  <Table.Tr
                    key={run.id}
                    style={{
                      backgroundColor: isSelected
                        ? 'var(--mantine-color-blue-light)'
                        : undefined,
                    }}
                  >
                    <Table.Td>
                      <Text fw={600} size="sm">
                        {run.criteria?.keywords || 'Job Discovery'} in{' '}
                        {run.criteria?.location || 'Germany'}
                      </Text>
                      <Text
                        size="xs"
                        c="dimmed"
                        truncate
                        style={{ maxWidth: 380 }}
                      >
                        "{run.prompt}"
                      </Text>
                      <Group gap={4} mt={4}>
                        {run.criteria?.easyApplyOnly && (
                          <Badge size="xs" color="blue" variant="light">
                            Easy Apply
                          </Badge>
                        )}
                        <Badge size="xs" color="gray" variant="outline">
                          {run.criteria?.languageRule?.germanRequirement ||
                            'any language'}
                        </Badge>
                      </Group>
                    </Table.Td>

                    <Table.Td>
                      {isRunning && (
                        <Badge color="blue" variant="dot">
                          Running...
                        </Badge>
                      )}
                      {isCompleted && (
                        <Badge color="green" variant="filled">
                          Completed
                        </Badge>
                      )}
                      {run.status === 'error' && (
                        <Badge color="red" variant="filled">
                          Error
                        </Badge>
                      )}
                    </Table.Td>

                    <Table.Td>
                      <Text size="xs" fw={600} mb={4}>
                        {run.qualifiedCount} / {run.targetCount} qualified
                      </Text>
                      <Progress
                        value={percent}
                        size="sm"
                        color={isCompleted ? 'green' : 'blue'}
                        animated={isRunning}
                        radius="xl"
                      />
                    </Table.Td>

                    <Table.Td>
                      <Group gap={4}>
                        <IconClock size={13} color="gray" />
                        <Text size="xs" c="dimmed">
                          {new Date(run.createdAt).toLocaleTimeString([], {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </Text>
                      </Group>
                    </Table.Td>

                    <Table.Td style={{ textAlign: 'right' }}>
                      <Group gap="xs" justify="flex-end">
                        <Button
                          size="xs"
                          variant={isSelected ? 'filled' : 'light'}
                          color="blue"
                          leftSection={<IconEye size={13} />}
                          onClick={() => setSelectedRunId(run.id)}
                        >
                          View
                        </Button>

                        <Tooltip
                          label={
                            isCompleted || run.qualifiedCount > 0
                              ? 'Download CSV of qualified jobs'
                              : 'Search is still gathering jobs'
                          }
                        >
                          <Button
                            size="xs"
                            variant="filled"
                            color="green"
                            leftSection={<IconDownload size={13} />}
                            disabled={run.qualifiedCount === 0}
                            onClick={() => handleDownloadCsv(run.id)}
                          >
                            CSV
                          </Button>
                        </Tooltip>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        )}
      </Paper>

      {/* Selected Search Details & Evaluated Jobs */}
      {runDetails && (
        <Stack gap="md">
          <Group justify="space-between" align="center">
            <Box>
              <Text fw={700} size="md">
                Search Results: "{runDetails.prompt}"
              </Text>
              <Text size="xs" c="dimmed">
                {runDetails.scannedCount} total jobs scanned ·{' '}
                {runDetails.qualifiedCount} passed criteria ·{' '}
                {runDetails.rejectedCount} rejected
              </Text>
            </Box>

            {runDetails.qualifiedCount > 0 && (
              <Group gap="xs">
                <Badge
                  color="teal"
                  variant="light"
                  leftSection={<IconDatabase size={13} />}
                >
                  Saved to Database ({runDetails.qualifiedCount})
                </Badge>
                <Button
                  size="xs"
                  variant="filled"
                  color="green"
                  leftSection={<IconDownload size={14} />}
                  onClick={() => handleDownloadCsv(runDetails.id)}
                >
                  Download CSV ({runDetails.qualifiedCount} Qualified)
                </Button>
              </Group>
            )}
          </Group>

          {/* Criteria Metric Cards */}
          <SimpleGrid cols={{ base: 1, sm: 4 }} spacing="sm">
            <Card withBorder padding="sm" radius="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                Search Query
              </Text>
              <Group gap="xs" mt={4}>
                <IconSearch size={18} color="#228be6" />
                <Text fw={600} size="sm" truncate>
                  {runDetails.criteria?.keywords}
                </Text>
              </Group>
            </Card>

            <Card withBorder padding="sm" radius="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                Location
              </Text>
              <Group gap="xs" mt={4}>
                <IconMapPin size={18} color="#fd7e14" />
                <Text fw={600} size="sm" truncate>
                  {runDetails.criteria?.location}
                </Text>
              </Group>
            </Card>

            <Card withBorder padding="sm" radius="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                Language Rule
              </Text>
              <Group gap="xs" mt={4}>
                <IconLanguage size={18} color="#40c057" />
                <Text fw={600} size="sm" truncate>
                  {runDetails.criteria?.languageRule?.germanRequirement}
                </Text>
              </Group>
            </Card>

            <Card withBorder padding="sm" radius="md">
              <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
                Goal Progress
              </Text>
              <Group gap="xs" mt={4}>
                <IconBriefcase size={18} color="#7950f2" />
                <Text fw={600} size="sm">
                  {runDetails.qualifiedCount} / {runDetails.targetCount}{' '}
                  qualified
                </Text>
              </Group>
            </Card>
          </SimpleGrid>

          {/* Filter Tabs */}
          <Group justify="space-between" align="center">
            <Group gap="xs">
              <Button
                size="xs"
                variant={filterTab === 'passed' ? 'filled' : 'light'}
                color="green"
                onClick={() => setFilterTab('passed')}
              >
                Passed ({runDetails.qualifiedCount})
              </Button>
              <Button
                size="xs"
                variant={filterTab === 'rejected' ? 'filled' : 'light'}
                color="red"
                onClick={() => setFilterTab('rejected')}
              >
                Rejected ({runDetails.rejectedCount})
              </Button>
              <Button
                size="xs"
                variant={filterTab === 'all' ? 'filled' : 'subtle'}
                color="gray"
                onClick={() => setFilterTab('all')}
              >
                All Evaluated ({runDetails.jobs.length})
              </Button>
            </Group>
          </Group>

          {/* Evaluated Jobs Table */}
          <Paper withBorder radius="md" style={{ overflow: 'hidden' }}>
            <ScrollArea>
              <Table verticalSpacing="sm" highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th style={{ width: 40 }}>Fit</Table.Th>
                    <Table.Th>Position & Company</Table.Th>
                    <Table.Th>Location</Table.Th>
                    <Table.Th>Language Assessment</Table.Th>
                    <Table.Th>AI Verdict / Reason</Table.Th>
                    <Table.Th style={{ width: 80 }}>Link</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {displayedJobs.length === 0 ? (
                    <Table.Tr>
                      <Table.Td
                        colSpan={6}
                        style={{ textAlign: 'center', padding: '30px' }}
                      >
                        <Text c="dimmed" size="sm">
                          {runDetails.status === 'running'
                            ? 'Evaluating candidate jobs from LinkedIn...'
                            : 'No jobs match this filter.'}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  ) : (
                    displayedJobs.map((job) => (
                      <>
                        <Table.Tr
                          key={job.jobId}
                          style={{ cursor: 'pointer' }}
                          onClick={() =>
                            setExpandedJobId(
                              expandedJobId === job.jobId ? null : job.jobId,
                            )
                          }
                        >
                          <Table.Td>
                            {job.passed ? (
                              <ThemeIcon
                                color="green"
                                variant="light"
                                size="sm"
                                radius="xl"
                              >
                                <IconCheck size={14} />
                              </ThemeIcon>
                            ) : (
                              <ThemeIcon
                                color="red"
                                variant="light"
                                size="sm"
                                radius="xl"
                              >
                                <IconX size={14} />
                              </ThemeIcon>
                            )}
                          </Table.Td>
                          <Table.Td>
                            <Text fw={600} size="sm">
                              {job.title}
                            </Text>
                            <Text size="xs" c="dimmed">
                              {job.company} · {job.postedDate}
                            </Text>
                          </Table.Td>
                          <Table.Td>
                            <Text size="sm">{job.location}</Text>
                          </Table.Td>
                          <Table.Td>
                            <Badge
                              size="sm"
                              variant="light"
                              color={job.passed ? 'green' : 'orange'}
                            >
                              {job.languageAssessment}
                            </Badge>
                          </Table.Td>
                          <Table.Td>
                            <Text size="xs" c={job.passed ? 'dimmed' : 'red'}>
                              {job.reason}
                            </Text>
                          </Table.Td>
                          <Table.Td onClick={(e) => e.stopPropagation()}>
                            <Tooltip label="Open on LinkedIn">
                              <Button
                                component="a"
                                href={job.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                size="xs"
                                variant="subtle"
                                p={4}
                              >
                                <IconExternalLink size={16} />
                              </Button>
                            </Tooltip>
                          </Table.Td>
                        </Table.Tr>

                        {/* Collapsible JD preview */}
                        {expandedJobId === job.jobId && (
                          <Table.Tr key={`${job.jobId}_detail`}>
                            <Table.Td
                              colSpan={6}
                              style={{
                                background:
                                  'var(--mantine-color-dark-8, #f8f9fa)',
                                padding: 16,
                              }}
                            >
                              <Text size="xs" fw={700} c="dimmed" mb={4}>
                                Job Description Excerpt:
                              </Text>
                              <Paper
                                p="xs"
                                radius="sm"
                                withBorder
                                style={{ maxHeight: 180, overflowY: 'auto' }}
                              >
                                <Text
                                  size="xs"
                                  style={{
                                    whiteSpace: 'pre-wrap',
                                    lineHeight: 1.5,
                                  }}
                                >
                                  {job.jdSnippet || 'No description available.'}
                                </Text>
                              </Paper>
                            </Table.Td>
                          </Table.Tr>
                        )}
                      </>
                    ))
                  )}
                </Table.Tbody>
              </Table>
            </ScrollArea>
          </Paper>
        </Stack>
      )}
    </Stack>
  );
}

export const EasyApplyFinderPage = JobFinderPage;
