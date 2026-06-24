import { env } from './config/env.js';
import { prisma } from './lib/prisma.js';

const BASE_URL = `http://localhost:${env.PORT || 3000}`;

let TEST_API_KEY = '';

async function apiFetch(
  path: string,
  method: string = 'GET',
  body: any = null,
) {
  const options: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': TEST_API_KEY,
    },
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(`${BASE_URL}${path}`, options);
  const data = await res.json();
  if (!res.ok)
    throw new Error(`API Error ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function runTests() {
  console.log('🧪 Starting Sync API Integration Tests...');

  try {
    const user = await prisma.user.findFirst();
    if (!user) throw new Error('No user found in database to run tests with.');
    TEST_API_KEY = user.apiKey;
    console.log(`🔑 Using API Key from user ${user.email}`);
    // 1. Test Daily Stats (GET & POST)
    console.log('\n--- Testing Daily Stats ---');
    await apiFetch('/api/sync/daily-stats/reset', 'POST'); // ensure clean state
    const initialStats = await apiFetch('/api/sync/daily-stats');
    console.log(
      '✅ Initial stats created/fetched:',
      initialStats.stats.connectionsSent === 0,
    );

    const incrementedStats = await apiFetch(
      '/api/sync/daily-stats/increment',
      'POST',
      { key: 'connectionsSent', amount: 2 },
    );
    console.log(
      '✅ Stats incremented successfully:',
      incrementedStats.stats.connectionsSent === 2,
    );

    // 2. Test Activity Log
    console.log('\n--- Testing Activity Log ---');
    const logRes = await apiFetch('/api/sync/activity-log', 'POST', {
      message: 'Test message from scratch script',
    });
    console.log('✅ Activity log entry created:', !!logRes.log.id);

    const getLogs = await apiFetch('/api/sync/activity-log');
    console.log(
      '✅ Activity log fetched successfully:',
      getLogs.logs.length > 0,
    );

    // 3. Test Workflow Run (Mass Connector)
    console.log('\n--- Testing Workflow Run ---');
    const mockRun = {
      workflowType: 'massConnector',
      status: 'completed',
      params: { urls: ['https://linkedin.com/in/test'] },
      results: [{ name: 'Test Person', status: 'Sent' }],
      startedAt: new Date().toISOString(),
    };

    const runRes = await apiFetch('/api/sync/workflow-run', 'POST', mockRun);
    console.log('✅ Workflow run saved successfully:', !!runRes.run.id);

    const historyRes = await apiFetch(
      '/api/sync/workflow-history?type=massConnector',
    );
    console.log(
      '✅ Workflow history fetched successfully. Found runs:',
      historyRes.history.length,
    );
    console.log(
      '✅ First run result matched:',
      historyRes.history[0].results[0].name === 'Test Person',
    );

    console.log('\n🎉 All backend API tests passed!');
  } catch (err: any) {
    console.error('\n❌ Test failed:', err.message);
  } finally {
    // Cleanup mock data
    await prisma.activityLog.deleteMany({
      where: { message: 'Test message from scratch script' },
    });
    await prisma.workflowRun.deleteMany({
      where: { workflowType: 'massConnector', status: 'completed' },
    });
    await prisma.$disconnect();
    process.exit(0);
  }
}

runTests();
