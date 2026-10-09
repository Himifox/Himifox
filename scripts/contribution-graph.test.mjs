import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dateRange, parseDays, renderGraph, updateGraph } from './contribution-graph.mjs';

const now = new Date('2026-01-15T12:00:00Z');
const range = dateRange(now);
function fixture(count = 2) {
  const days = Array.from({ length: 31 }, (_, i) => ({
    date: new Date(Date.parse(range.from) + i * 86_400_000).toISOString().slice(0, 10),
    contributionCount: count,
  }));
  return { data: { user: { contributionsCollection: { contributionCalendar: {
    weeks: [{ contributionDays: days }],
  } } } } };
}

test('range covers 31 UTC dates across a year boundary', () => {
  assert.equal(range.from, '2025-12-16T00:00:00.000Z');
  assert.equal(range.to, '2026-01-15T12:00:00.000Z');
});

test('calendar grouping and order do not change the graph', () => {
  const payload = fixture();
  const days = parseDays(payload, range.from, range.to);
  payload.data.user.contributionsCollection.contributionCalendar.weeks = [
    { contributionDays: days.slice(15).reverse() }, { contributionDays: days.slice(0, 15) },
  ];
  assert.deepEqual(parseDays(payload, range.from, range.to), days);
  const svg = renderGraph(days);
  assert.match(svg, /62 contributions/);
  assert.equal((svg.match(/<circle /g) ?? []).length, 31);
});

test('zero contributions render without invalid coordinates', () => {
  const svg = renderGraph(parseDays(fixture(0), range.from, range.to));
  assert.doesNotMatch(svg, /NaN|Infinity/);
  assert.match(svg, /0 contributions/);
});

test('rejects errors, missing dates, duplicates and invalid counts', () => {
  assert.throws(() => parseDays({ errors: [{ message: 'Failure' }] }, range.from, range.to));
  assert.throws(() => parseDays({ data: { user: null } }, range.from, range.to));
  for (const mutate of [
    days => days.pop(),
    days => { days[1] = days[0]; },
    days => { days[0].contributionCount = -1; },
    days => { days[0].contributionCount = 1.5; },
    days => { days[0].contributionCount = '2'; },
  ]) {
    const payload = fixture();
    mutate(payload.data.user.contributionsCollection.contributionCalendar.weeks[0].contributionDays);
    assert.throws(() => parseDays(payload, range.from, range.to));
  }
});

test('successful update replaces SVG; failed updates preserve it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'contribution-graph-'));
  const destination = pathToFileURL(join(directory, 'graph.svg'));
  try {
    await writeFile(destination, 'previous graph');
    for (const fetchImpl of [
      async () => ({ ok: false, status: 402 }),
      async () => ({ ok: true, json: async () => ({ errors: [{}] }) }),
      async () => ({ ok: true, json: async () => fixture(-1) }),
      async () => { throw new Error('Network failure'); },
    ]) {
      await assert.rejects(updateGraph({ token: 'test', fetchImpl, now, destination }));
      assert.equal(await readFile(destination, 'utf8'), 'previous graph');
    }
    await assert.rejects(updateGraph({ now, destination }), /GH_TOKEN/);
    await updateGraph({ token: 'test', now, destination, fetchImpl: async (_, options) => {
      assert.deepEqual(JSON.parse(options.body).variables, range);
      return { ok: true, json: async () => fixture() };
    } });
    assert.match(await readFile(destination, 'utf8'), /62 contributions/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
