import { createApiClient, unwrap } from '@/api/client';
import i18n from '@/i18n';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

describe('Accept-Language', () => {
  afterEach(() => void i18n.changeLanguage('en'));

  it('sends the app language as a primary tag on every request', async () => {
    const seen: (string | null)[] = [];
    const fetch = async (request: Request) => {
      seen.push(request.headers.get('Accept-Language'));
      return json({ rows: [] });
    };
    const client = createApiClient({ baseUrl: 'http://server.test', fetch });
    await unwrap(client.GET('/api/v1/viewer/catalog/discover'));
    await i18n.changeLanguage('de');
    await unwrap(client.GET('/api/v1/viewer/catalog/discover'));
    expect(seen).toEqual(['en', 'de']);
  });
});
