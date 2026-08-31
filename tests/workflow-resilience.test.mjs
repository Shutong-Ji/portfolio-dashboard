import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflow = await readFile(
  new URL('../.github/workflows/update-portfolio.yml', import.meta.url),
  'utf8',
);

test('runs several idempotent recovery windows every weekday', () => {
  const schedules = [...workflow.matchAll(/cron:\s*'([^']+)'/g)].map(match => match[1]);
  assert.equal(schedules.length, 5);
  assert.ok(schedules.every(schedule => schedule.endsWith('* * 1-5')));
});

test('retries transient updater failures and has a bounded runtime', () => {
  assert.match(workflow, /timeout-minutes:\s*20/);
  assert.match(workflow, /for attempt in 1 2 3/);
  assert.match(workflow, /for push_attempt in 1 2 3/);
  assert.match(workflow, /if git fetch origin main; then/);
  assert.match(workflow, /git rebase origin\/main/);
  assert.match(workflow, /sleep \$\(\(push_attempt \* 30\)\)/);
  assert.match(workflow, /All update attempts failed/);
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.match(workflow, /group:\s*portfolio-dashboard-update/);
});
