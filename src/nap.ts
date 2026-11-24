// Portugal National Access Point (NAP) feeds, published by MOBI.E in DATEX II v3 XML.
// Static (~180 MB) and status (~37 MB) are streamed and parsed on the fly, so memory stays low,
// then reduced to small JSON payloads for the app.
import { SaxesParser } from 'saxes';
import type {
  ChargePoint, ChargersPayload, Connector, ConnectorType, PointLive, Site, StatusCode, StatusPayload,
} from './types.ts';

export const NAP_STATIC_URL = 'https://pgm.mobie.pt/integration/nap/evChargingInfra';
export const NAP_STATUS_URL = 'https://pgm.mobie.pt/integration/nap/evActualStatus';

const local = (name: string) => {
  const i = name.indexOf(':');
  return i === -1 ? name : name.slice(i + 1);
};

/** Streams an HTTP response into a SAX parser without buffering the whole body. */
async function streamXml(url: string, parser: SaxesParser, timeoutMs: number) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`Timeout after ${timeoutMs / 1000}s fetching ${url}`)), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/xml', 'Accept-Encoding': 'gzip' } });
    if (!res.ok || !res.body) throw new Error(`NAP responded ${res.status} for ${url}`);
    const decoder = new TextDecoder('utf-8');
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      parser.write(decoder.decode(chunk, { stream: true }));
    }
    parser.write(decoder.decode());
    parser.close();
  } finally {
    clearTimeout(timer);
  }
}

const CONNECTOR_MAP: Record<string, ConnectorType> = {
  iec62196T2: 'T2',
  iec62196T2COMBO: 'CCS',
  chademo: 'CHA',
  domesticF: 'SCH',
  domesticG: 'SCH',
  domestic: 'SCH',
  iec60309x2single16: 'IND',
  iec60309x2three16: 'IND',
  iec60309x2three32: 'IND',
};

const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

export async function fetchStatic(): Promise<ChargersPayload> {
  const parser = new SaxesParser();
  const stack: string[] = [];
  const sites: Site[] = [];
  let publishedAt = '';
  let site: Site | null = null;
  let point: ChargePoint | null = null;
  let conn: (Partial<Connector> & { mode?: string; type?: string }) | null = null;
  let text = '';
  let inOperator = false;

  const path = (n: number) => stack.slice(-n).join('/');

  parser.on('opentag', (tag) => {
    const name = local(tag.name);
    stack.push(name);
    text = '';
    if (name === 'energyInfrastructureSite') {
      site = { id: String(tag.attributes.id ?? ''), name: '', op: '', lat: NaN, lon: NaN, addr: '', city: '', pts: [], maxP: 0, types: [] };
    } else if (name === 'operator' && site) {
      inOperator = true;
    } else if (name === 'refillPoint' && site) {
      point = { id: String(tag.attributes.id ?? ''), c: [] };
    } else if (name === 'connector' && point) {
      conn = {};
    }
  });

  parser.on('text', (t) => { text += t; });

  parser.on('closetag', (tag) => {
    const name = local(tag.name);
    const value = text.trim();
    text = '';
    if (name === 'publicationTime' && stack.length === 2) publishedAt = value;
    if (site) {
      const p3 = path(3);
      if (name === 'value') {
        // .../name/values/value  (site name vs operator name)
        if (p3 === 'name/values/value') {
          if (inOperator) { if (!site.op) site.op = value; }
          else if (!point && !site.name) site.name = value;
        } else if (p3 === 'city/values/value') site.city = value;
        else if (p3 === 'text/values/value' && stack.includes('addressLine') && !site.addr) site.addr = value;
      } else if (name === 'latitude') site.lat = parseFloat(value);
      else if (name === 'longitude') site.lon = parseFloat(value);
      else if (name === 'lastUpdated' && stack.length <= 5) site.updated = value;
      else if (name === 'linkToGeneralInformation' && inOperator) site.opUrl = value;
      else if (name === 'operator') inOperator = false;
      else if (name === 'externalIdentifier' && point && !point.evse) point.evse = value;
      else if (conn) {
        if (name === 'connectorType') conn.type = value;
        else if (name === 'chargingMode') conn.mode = value;
        else if (name === 'connectorFormat') conn.cable = value === 'cableMode3' || value === 'cable';
        else if (name === 'maxPowerAtSocket') conn.p = round(parseFloat(value) / 1000);
        else if (name === 'connector' && point) {
          const t = CONNECTOR_MAP[conn.type ?? ''] ?? 'OTH';
          const dc = conn.mode === 'mode4DC' || t === 'CCS' || t === 'CHA';
          point.c.push({ t, p: Number.isFinite(conn.p) ? conn.p! : 0, dc, cable: !!conn.cable || t === 'CCS' || t === 'CHA' });
          conn = null;
        }
      }
      if (name === 'refillPoint' && point) {
        site.pts.push(point);
        point = null;
      }
      if (name === 'energyInfrastructureSite') {
        if (Number.isFinite(site.lat) && Number.isFinite(site.lon) && site.pts.length) {
          const all = site.pts.flatMap((p) => p.c);
          site.maxP = all.reduce((m, c) => Math.max(m, c.p), 0);
          site.types = [...new Set(all.map((c) => c.t))];
          if (!site.name) site.name = site.id;
          sites.push(site);
        }
        site = null;
      }
    }
    stack.pop();
  });

  parser.on('error', (e) => { throw e; });
  await streamXml(NAP_STATIC_URL, parser, 5 * 60_000);
  if (sites.length < 1000) throw new Error(`NAP static feed looked incomplete (${sites.length} sites)`);
  return { source: 'MOBI.E / NAP Portugal (DATEX II)', publishedAt, fetchedAt: new Date().toISOString(), sites };
}

const STATUS_MAP: Record<string, StatusCode> = {
  available: 'A',
  charging: 'C',
  occupied: 'C',
  reserved: 'C',
  outOfOrder: 'O',
  inoperative: 'O',
  blocked: 'O',
  faulted: 'O',
  planned: 'P',
  unknown: 'U',
};

export async function fetchStatus(): Promise<StatusPayload> {
  const parser = new SaxesParser();
  const stack: string[] = [];
  const points: Record<string, PointLive> = {};
  let publishedAt = '';
  let siteId = '';
  let pointId = '';
  let live: PointLive | null = null;
  let policy = '';
  let fee: number | null = null;
  let extra = '';
  let text = '';

  parser.on('opentag', (tag) => {
    const name = local(tag.name);
    stack.push(name);
    text = '';
    if (name === 'reference') {
      const parent = stack[stack.length - 2];
      const id = String(tag.attributes.id ?? '');
      if (parent === 'energyInfrastructureSiteStatus') siteId = id;
      else if (parent === 'refillPointStatus') pointId = id;
    } else if (name === 'refillPointStatus') {
      live = ['U', null, null, null, null];
      pointId = '';
    } else if (name === 'energyPricingPolicy') {
      policy = ''; fee = null; extra = '';
    }
  });
  parser.on('text', (t) => { text += t; });
  parser.on('closetag', (tag) => {
    const name = local(tag.name);
    const value = text.trim();
    text = '';
    if (name === 'publicationTime' && stack.length === 2) publishedAt = value;
    else if (live) {
      if (name === 'status') live[0] = STATUS_MAP[value] ?? 'U';
      else if (name === 'pricingPolicy') policy = value;
      else if (name === 'minimumDeliveryFee') fee = parseFloat(value);
      else if (name === 'value' && stack.includes('additionalInformation')) extra = value;
      else if (name === 'energyPricingPolicy' && fee !== null && Number.isFinite(fee)) {
        // Keep the first value of each kind (several tariff components can appear).
        if (extra.includes('parking')) { if (live[4] === null) live[4] = fee; }
        else if (policy === 'pricePerDeliveryUnit') { if (live[1] === null) live[1] = fee; }
        else if (policy === 'pricePerChargingTime') { if (live[2] === null) live[2] = fee; }
        else if (policy === 'flatRate') { if (live[3] === null) live[3] = fee; }
      } else if (name === 'refillPointStatus') {
        if (siteId && pointId) points[`${siteId}|${pointId}`] = live;
        live = null;
      }
    }
    stack.pop();
  });
  parser.on('error', (e) => { throw e; });
  await streamXml(NAP_STATUS_URL, parser, 2 * 60_000);
  if (Object.keys(points).length < 1000) throw new Error('NAP status feed looked incomplete');
  return { publishedAt, fetchedAt: new Date().toISOString(), points };
}
