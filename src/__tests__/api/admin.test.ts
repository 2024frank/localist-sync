import { NextRequest } from 'next/server';
import { GET } from '@/app/api/admin/stats/route';
import { adminAuth } from '@/lib/firebase-admin';

const db = require('@/lib/db');
const mockVerify = adminAuth.verifyIdToken as jest.Mock;

const MOCK_ADMIN    = { id: 1, role: 'admin',    email: 'admin@oberlin.edu', full_name: 'Admin', active: 1, firebase_uid: 'uid-admin' };
const MOCK_REVIEWER = { id: 2, role: 'reviewer', email: 'rev@oberlin.edu',   full_name: 'Rev',   active: 1, firebase_uid: 'uid-rev' };

function makeReq(params: Record<string, string> = {}) {
  const url = new URL('http://localhost/api/admin/stats');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  return new NextRequest(url, { headers: { Authorization: 'Bearer valid' } });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockVerify.mockResolvedValue({ uid: 'uid-admin', email: 'admin@oberlin.edu' });
});

describe('GET /api/admin/stats', () => {
  it('returns summary stats', async () => {
    db.default.query
      .mockResolvedValueOnce([[MOCK_ADMIN]])
      .mockResolvedValueOnce([[{ total_extracted: 50, total_approved: 35, total_rejected: 15, total_pending: 5 }]]) // live
      .mockResolvedValueOnce([[{ total_extracted: 0,  total_approved: 0,  total_rejected: 0 }]]);                  // arch

    const res  = await GET(makeReq());
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.total_extracted).toBe(50);
    expect(data.approval_rate).toBe(70.0);
  });

  it('returns by-source breakdown', async () => {
    db.default.query
      .mockResolvedValueOnce([[MOCK_ADMIN]])
      .mockResolvedValueOnce([[
        { id: 1, name: 'Oberlin College', total: 30, approved: 25, rejected: 4, pending: 1, approval_rate: 83.3 },
        { id: 2, name: 'Apollo Theatre',  total: 20, approved: 10, rejected: 6, pending: 4, approval_rate: 50.0 },
      ]]);

    const res  = await GET(makeReq({ type: 'by-source' }));
    const data = await res.json();
    expect(data).toHaveLength(2);
    expect(data[0].name).toBe('Oberlin College');
  });

  it('returns rejection reasons flattened from JSON arrays', async () => {
    db.default.query
      .mockResolvedValueOnce([[MOCK_ADMIN]])
      .mockResolvedValueOnce([[
        { reason_codes: JSON.stringify(['wrong_audience']),            n: 8 },
        { reason_codes: JSON.stringify(['bad_date_parse']),            n: 4 },
        { reason_codes: JSON.stringify(['missing_fields','bad_location']), n: 2 },
      ]]);

    const res  = await GET(makeReq({ type: 'rejection-reasons' }));
    const data = await res.json();
    const wrongAudience = data.find((r: any) => r.reason === 'wrong_audience');
    expect(wrongAudience.count).toBe(8);
    const missingFields = data.find((r: any) => r.reason === 'missing_fields');
    expect(missingFields.count).toBe(2);
  });

  it('returns field edits sorted by frequency', async () => {
    db.default.query
      .mockResolvedValueOnce([[MOCK_ADMIN]])
      .mockResolvedValueOnce([[
        { field_name: 'sessions', edits: 22 },
        { field_name: 'location', edits: 15 },
      ]]);

    const res  = await GET(makeReq({ type: 'field-edits' }));
    const data = await res.json();
    expect(data[0].field_name).toBe('sessions');
    expect(data[0].edits).toBe(22);
  });

  it('returns timeline data', async () => {
    db.default.query
      .mockResolvedValueOnce([[MOCK_ADMIN]])
      .mockResolvedValueOnce([[
        { date: '2026-05-01', extracted: 10, approved: 7, rejected: 2 },
        { date: '2026-05-02', extracted: 5,  approved: 4, rejected: 1 },
      ]]);

    const res  = await GET(makeReq({ type: 'timeline' }));
    const data = await res.json();
    expect(data).toHaveLength(2);
    expect(data[0].extracted).toBe(10);
  });

  it('returns 403 for reviewer', async () => {
    mockVerify.mockResolvedValue({ uid: 'uid-rev', email: 'rev@oberlin.edu' });
    db.default.query.mockResolvedValueOnce([[MOCK_REVIEWER]]);
    const res = await GET(makeReq());
    expect(res.status).toBe(403);
  });

  it('returns CSV with correct content-type', async () => {
    db.default.query
      .mockResolvedValueOnce([[MOCK_ADMIN]])
      .mockResolvedValueOnce([[
        { id: 1, source: 'Oberlin College', event_type: 'ot', title: 'Jazz Night', status: 'approved' },
      ]]);

    const res = await GET(makeReq({ type: 'export', format: 'csv', export_type: 'events' }));
    expect(res.headers.get('content-type')).toContain('text/csv');
  });
});
