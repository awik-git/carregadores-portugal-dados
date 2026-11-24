// Data shapes shared by the server and the app.
// Kept compact on purpose: the whole of Portugal is ~9k sites / ~20k points.

/** Connector type codes (simplified from DATEX II). */
export type ConnectorType = 'T2' | 'CCS' | 'CHA' | 'SCH' | 'IND' | 'OTH';

export interface Connector {
  t: ConnectorType;
  /** Max power in kW */
  p: number;
  /** true when DC */
  dc: boolean;
  /** true = tethered cable, false = socket (bring your own cable) */
  cable: boolean;
}

export interface ChargePoint {
  /** Point id as used by the status feed */
  id: string;
  /** EVSE id, e.g. PT*EZC*E*AMD*00051*1 */
  evse?: string;
  c: Connector[];
}

export interface Site {
  id: string;
  name: string;
  op: string;
  opUrl?: string;
  lat: number;
  lon: number;
  addr: string;
  city: string;
  pts: ChargePoint[];
  /** Max power over all connectors (kW), precomputed for filters/markers */
  maxP: number;
  /** All connector types present */
  types: ConnectorType[];
  updated?: string;
}

export interface ChargersPayload {
  source: string;
  publishedAt: string;
  fetchedAt: string;
  sites: Site[];
}

/** Status codes, kept as single letters to keep the payload small. */
export type StatusCode =
  | 'A' // available
  | 'C' // charging / occupied
  | 'O' // out of order / inoperative / blocked
  | 'P' // planned (not yet open)
  | 'U'; // unknown

/** [status, €/kWh, €/min, € flat per session, €/min parking] — prices null when absent */
export type PointLive = [StatusCode, number | null, number | null, number | null, number | null];

export interface StatusPayload {
  publishedAt: string;
  fetchedAt: string;
  /** key = `${siteId}|${pointId}` */
  points: Record<string, PointLive>;
}

export const statusKey = (siteId: string, pointId: string) => `${siteId}|${pointId}`;
