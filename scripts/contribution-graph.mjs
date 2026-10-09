import { writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const dayMs = 86_400_000;
const output = new URL('../assets/contribution-graph.svg', import.meta.url);

export function dateRange(now = new Date()) {
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - 30);
  return { from: start.toISOString(), to: now.toISOString() };
}

export function parseDays(payload, from, to) {
  if (payload.errors?.length) throw new Error('GitHub returned GraphQL errors');
  const weeks = payload.data?.user?.contributionsCollection?.contributionCalendar?.weeks;
  if (!Array.isArray(weeks)) throw new Error('Missing contribution calendar');
  const days = weeks.flatMap(week => week.contributionDays ?? [])
    .filter(day => typeof day.date === 'string' && day.date >= from.slice(0, 10) && day.date <= to.slice(0, 10))
    .sort((a, b) => a.date.localeCompare(b.date));
  // Reject incomplete or invalid data before touching the last successful graph.
  if (days.length !== 31 || days.some((day, index) =>
    day.date !== new Date(Date.parse(from) + index * dayMs).toISOString().slice(0, 10)
    || !Number.isSafeInteger(day.contributionCount) || day.contributionCount < 0)) {
    throw new Error('Expected 31 consecutive days with valid contribution counts');
  }
  return days;
}

export function renderGraph(days) {
  const left = 62, right = 932, top = 64, bottom = 238;
  const max = Math.max(1, ...days.map(day => day.contributionCount));
  const points = days.map((day, index) => ({
    x: left + index * (right - left) / (days.length - 1),
    y: bottom - day.contributionCount / max * (bottom - top),
    ...day,
  }));
  const line = points.map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ');
  const grid = [0, 0.5, 1].map(fraction => {
    const y = bottom - fraction * (bottom - top);
    return `<path d="M${left} ${y}H${right}" stroke="#8b949e" stroke-opacity=".18"/><text x="50" y="${y + 4}" text-anchor="end">${Number((fraction * max).toFixed(1))}</text>`;
  }).join('\n');
  const labels = points.filter((_, i) => i % 5 === 0).map(p =>
    `<text x="${p.x}" y="263" text-anchor="middle">${p.date.slice(5)}</text>`).join('\n');
  const dots = points.map(p => `<circle cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="3" fill="#f97316"><title>${p.date}: ${p.contributionCount} contributions</title></circle>`).join('\n');
  const total = days.reduce((sum, day) => sum + day.contributionCount, 0);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="300" viewBox="0 0 960 300" role="img" aria-labelledby="title description">
  <title id="title">Contribution rhythm</title>
  <desc id="description">Himifox: ${total} contributions from ${days[0].date} to ${days.at(-1).date} (UTC). Generated from GitHub contribution data.</desc>
  <g font-family="-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif" font-size="12" fill="#8b949e">
    <text x="480" y="30" text-anchor="middle" font-size="20" font-weight="600">Contribution rhythm</text>
    ${grid}
    <polygon points="${left},${bottom} ${line} ${right},${bottom}" fill="#2f81f7" fill-opacity=".16"/>
    <polyline points="${line}" fill="none" stroke="#2f81f7" stroke-width="2.5" stroke-linejoin="round"/>
    ${dots}
    ${labels}
    <text x="480" y="289" text-anchor="middle">${total} contributions · Last 31 days · UTC</text>
  </g>
</svg>
`;
}

export async function updateGraph({ token, fetchImpl = fetch, now = new Date(), destination = output } = {}) {
  if (!token) throw new Error('GH_TOKEN is required');
  const { from, to } = dateRange(now);
  const response = await fetchImpl('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `query($from: DateTime!, $to: DateTime!) {
        user(login: "Himifox") {
          contributionsCollection(from: $from, to: $to) {
            contributionCalendar { weeks { contributionDays { date contributionCount } } }
          }
        }
      }`,
      variables: { from, to },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}`);
  const days = parseDays(await response.json(), from, to);
  const svg = renderGraph(days);
  const temporary = new URL(`${destination.href}.tmp`);
  await writeFile(temporary, svg, 'utf8');
  await rename(temporary, destination);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  updateGraph({ token: process.env.GH_TOKEN }).catch(error => {
    console.error(`Contribution graph update failed: ${error.message}`);
    process.exitCode = 1;
  });
}
