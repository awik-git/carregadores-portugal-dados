// Downloads one MOBI.E NAP feed, reduces it to compact JSON and writes it to out/.
//   node src/build.ts static   -> out/chargers.json  (charger infrastructure, once a day)
//   node src/build.ts status   -> out/status.json    (live availability + prices, every few minutes)
// prev/ holds the files currently published (if any): used to skip unchanged feeds.
// Any failure keeps the previously published data and exits 0 (no point in failing loudly every 5 min
// while MOBI.E is down); the job log shows a warning instead.
import fs from 'node:fs';
import { NAP_STATUS_URL, fetchStatic, fetchStatus } from './nap.ts';

const kind = process.argv[2];
fs.mkdirSync('out', { recursive: true });
const warn = (m: string) => console.log(`::warning::${m}`);
const write = (name: string, data: unknown) => {
  const json = JSON.stringify(data);
  fs.writeFileSync(`out/${name}`, json);
  console.log(`${name}: ${(json.length / 1e6).toFixed(2)} MB`);
};
const readPrev = (name: string) => { try { return JSON.parse(fs.readFileSync(`prev/${name}`, 'utf8')); } catch { return null; } };

async function feedTag(url: string): Promise<string> {
  // Tiny HEAD request: the feed's ETag changes when MOBI.E publishes new data.
  const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(20_000) });
  return res.headers.get('etag') ?? '';
}

try {
  if (kind === 'static') {
    const payload = await fetchStatic();
    write('chargers.json', payload);
    write('meta.json', { chargers: { publishedAt: payload.publishedAt, fetchedAt: payload.fetchedAt, sites: payload.sites.length } });
  } else if (kind === 'status') {
    const prevMeta = readPrev('meta.json');
    const tag = await feedTag(NAP_STATUS_URL).catch(() => '');
    if (tag && prevMeta?.status?.etag === tag) {
      console.log('Status feed unchanged since last run, nothing to publish.');
      fs.writeFileSync('out/.skip', '');
    } else {
      const payload = await fetchStatus();
      write('status.json', payload);
      write('meta.json', { status: { publishedAt: payload.publishedAt, fetchedAt: payload.fetchedAt, points: Object.keys(payload.points).length, etag: tag } });
    }
  } else {
    throw new Error(`unknown kind "${kind}" (use static or status)`);
  }
} catch (e) {
  warn(`Feed update failed, keeping the previous data: ${(e as Error).message ?? e}`);
  fs.writeFileSync('out/.skip', '');
}
