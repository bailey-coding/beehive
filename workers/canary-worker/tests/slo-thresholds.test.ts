import { describe, expect, it } from 'vitest';
import { DEFAULT_SLO_ERROR_RATE, DEFAULT_SLO_LATENCY_P95_MS, sloThresholds } from '../slo';

const t = (latency?: string, err?: string) =>
  sloThresholds({ CANARY_SLO_LATENCY_P95: latency as string, CANARY_SLO_ERROR_RATE: err as string });

describe('sloThresholds (never NaN, never silently healthy)', () => {
  it('parses the configured values', () => {
    expect(t('800', '0.02')).toEqual({ latencyP95: 800, errorRate: 0.02 });
  });
  it('unset or blank takes the defaults', () => {
    expect(t(undefined, undefined)).toEqual({ latencyP95: DEFAULT_SLO_LATENCY_P95_MS, errorRate: DEFAULT_SLO_ERROR_RATE });
    expect(t('', '  ')).toEqual({ latencyP95: 1000, errorRate: 0.01 });
  });
  it.each([
    ['garbage latency', 'fast', '0.01'],
    ['zero latency', '0', '0.01'],
    ['negative latency', '-5', '0.01'],
    ['garbage error rate', '1000', 'low'],
    ['error rate above 1', '1000', '2'],
    ['zero error rate', '1000', '0'],
    ['trailing junk', '1000ms', '0.01'],
  ])('%s -> throws (no verdict)', (_n, l, e) => {
    expect(() => t(l, e)).toThrow(/Invalid CANARY_SLO_/);
  });
});
