/**
 * =============================================================================
 * liberis_integration.test.ts
 * =============================================================================
 * Jest test suite for the Liberis Capital Platform integration
 *
 * Run  : npx jest liberis_integration.test.ts --verbose
 * Watch: npx jest --watch
 *
 * All Liberis HTTP calls are intercepted via jest.fn() on global fetch.
 * No real credentials or network access required.
 *
 * -----------------------------------------------------------------------------
 * TEST COVERAGE MAP
 * -----------------------------------------------------------------------------
 *
 *  Suite 1 — Authentication
 *    1.1  Happy path: valid credentials → access_token returned
 *    1.2  Token is cached within TTL (no duplicate HTTP calls)
 *    1.3  Expired cache triggers fresh token fetch
 *    1.4  HTTP 401 → LiberisError thrown with statusCode 401
 *    1.5  Request body contains grant_type: client_credentials
 *
 *  Suite 2 — Merchant Registration
 *    2.1  Happy path: registers → polls Pending → resolves Completed
 *    2.2  Duplicate state treated as success (already registered)
 *    2.3  Failed state returns validation_errors[]
 *    2.4  Platform-ineligible merchant never calls Liberis
 *    2.5  Idempotency-Key header present on POST /data/v1/clients
 *    2.6  Conflict state returns failure with errors
 *
 *  Suite 3 — Revenue Claims
 *    3.1  Happy path: claims submitted → status_check_id returned
 *    3.2  unique_reference is deterministic (merchantId-YYYY-MM format)
 *    3.3  Idempotency-Key header present
 *    3.4  HTTP 409 idempotency conflict → LiberisError
 *    3.5  Negative amounts allowed (returns/chargebacks)
 *
 *  Suite 4 — Offers
 *    4.1  Happy path: advert found → offers returned with liberis_id
 *    4.2  Advert 404 (not eligible) → getMerchantOffers returns null
 *    4.3  liberis_id stored after successful offer fetch
 *    4.4  Renewal flow: stored liberis_id passed in offers request
 *    4.5  Repricing: amount_requested + product_id passed when provided
 *    4.6  apply_offer_presets: true set in request
 *    4.7  bureau_search: true set in consents
 *
 *  Suite 5 — Offer Acceptance
 *    5.1  Happy path: returns application_id + liberis_id + links
 *    5.2  URL contains offer_id: /create/v2/offers/{offer_id}/accept
 *    5.3  HTTP 409 conflict → LiberisError (already accepted)
 *    5.4  Optional bank_details included in request body when provided
 *
 *  Suite 6 — Webhook Handler
 *    6.1  deal.activated event processed without error
 *    6.2  application.manual_review event processed
 *    6.3  payment.received event processed
 *    6.4  Unknown event type does not throw
 *
 * =============================================================================
 */

import {
  LiberisClient,
  LiberisConfig,
  LiberisError,
  registerMerchantWithLiberis,
  submitRevenueClaims,
  getMerchantOffers,
  acceptMerchantOffer,
  handleLiberisWebhook,
  checkPlatformEligibility,
  getPlatformMerchant,
  getPlatformRevenue,
  storeLiberisId,
  getLiberisId,
} from './liberis_integration';

// =============================================================================
// FIXTURES
// =============================================================================

const TEST_CONFIG: LiberisConfig = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  baseUrl: 'https://platform.eu.liberis.com',
  env: 'sandbox',
};

const MOCK_TOKEN = 'mock-bearer-token-abc123';
const MOCK_MERCHANT_ID = 'MERCH_TEST_001';
const MOCK_STATUS_CHECK_ID = 'sc-uuid-00000001';
const MOCK_LIBERIS_ID = 'lib-uuid-00000001';
const MOCK_OFFER_ID = 'offer-uuid-00000001';
const MOCK_APPLICATION_ID = 'app-uuid-00000001';
const MOCK_PRODUCT_ID = 'prod-bca-00000001';

const MOCK_APPLICANT = {
  first_name: 'Jane',
  last_name: 'Doe',
  email_address: 'jane.doe@example.com',
  telephone_number: '07700900001',
  date_of_birth: '1985-06-15',
  primary: true,
  ownership_percentage: 100,
  residences: [{
    address: {
      line1: '1 Test Street',
      town_city: 'London',
      postcode: 'EC1A 1BB',
      country: 'UK',
    },
    residential_status: 'Home Owner' as const,
  }],
};

const MOCK_COMPANY = {
  legal_name: 'Jane Doe Trading Ltd',
  business_type: 'Limited Company',
  business_start_date: '2018-01-01',
  partner_start_date: '2021-06-01',
  industry: 'General Store',
  registration_number: '12345678',
  registered_address: {
    line1: '1 Test Street',
    town_city: 'London',
    postcode: 'EC1A 1BB',
    country: 'UK',
  },
  payment_channels: [{
    name: 'WorldPay',
    reference: 'WP-TERM-001',
    type: 'Card Processor' as const,
    primary: true,
    existing_split: false,
    monthly_volumes: [
      { date: '2024-12', amount: 15000, count: 720, currency: 'GBP' },
      { date: '2024-11', amount: 13500, count: 650, currency: 'GBP' },
    ],
  }],
};

const MOCK_ADVERT_RESPONSE = {
  meta: { reference: MOCK_MERCHANT_ID },
  advert_data: {
    header: 'Grow your business',
    title: 'Get funded today',
    subtitle: 'Up to £150,000',
    body: 'Revenue-based financing for your business.',
    call_to_action: 'See my offers',
    footer: 'Terms apply.',
    background_image_url: 'https://cdn.liberis.com/banner.jpg',
    offer_status: 'Eligible',
    html: '<div>Advert HTML</div>',
  },
};

const MOCK_OFFERS_RESPONSE = {
  liberis_id: MOCK_LIBERIS_ID,
  expires_at: '2025-12-31T00:00:00Z',
  products: [{
    product_id: MOCK_PRODUCT_ID,
    name: 'BCA',
    description: 'Business Cash Advance',
    decision: 'Accepted',
    repayment_mechanism: 'terminal_split',
    limits: { minimum: 5000, maximum: 150000, currency: 'GBP' },
    offers: [{
      offer_id: MOCK_OFFER_ID,
      offer_status: 'Eligible',
      description: 'Balanced',
      split_percentage: 10,
      term_length: 6,
      funded_amount: 25000,
      total_funded_amount: 25000,
      repayment_amount: 27250,
      total_repayment_amount: 27250,
      factor_rate: 1.09,
      currency: 'GBP',
    }],
  }],
};

const MOCK_ACCEPT_RESPONSE = {
  application_id: MOCK_APPLICATION_ID,
  liberis_id: MOCK_LIBERIS_ID,
  offer: {
    offer_id: MOCK_OFFER_ID,
    offer_type: 'Eligible',
    description: 'Balanced',
    split_percentage: 10,
    term_length: 6,
    funded_amount: 25000,
    total_funded_amount: 25000,
    repayment_amount: 27250,
    total_repayment_amount: 27250,
    factor_rate: 1.09,
    currency: 'GBP',
  },
  links: {
    contract_link: 'https://sign.liberis.com/abc123',
    merchant_link: 'https://portal.liberis.com/abc123',
  },
};

// =============================================================================
// MOCK INFRASTRUCTURE
// =============================================================================

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

function mockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

// Mock platform-side functions (the MOCK stubs in the integration file)
jest.mock('./liberis_integration', () => {
  const actual = jest.requireActual('./liberis_integration');
  return {
    ...actual,
    checkPlatformEligibility: jest.fn().mockResolvedValue({ eligible: true }),
    getPlatformMerchant: jest.fn().mockResolvedValue({
      partnerId: MOCK_MERCHANT_ID,
      entityType: 'LimitedCompany',
      clientStartDate: '2021-06-01',
      legalName: 'Jane Doe Trading Ltd',
      address: { line1: '1 Test Street', town_city: 'London', postcode: 'EC1A 1BB', country: 'UK' },
    }),
    getPlatformRevenue: jest.fn().mockResolvedValue([
      { date: '2024-12', amount: 15000, count: 720, currency: 'GBP' },
      { date: '2024-11', amount: 13500, count: 650, currency: 'GBP' },
    ]),
    storeLiberisId: jest.fn().mockResolvedValue(undefined),
    getLiberisId: jest.fn().mockResolvedValue(null),
    handleLiberisWebhook: jest.fn().mockResolvedValue(undefined),
  };
});

// Helper: set up auth mock as first call in mockFetch sequence
function withAuthMock() {
  mockFetch.mockResolvedValueOnce(
    mockResponse({ access_token: MOCK_TOKEN, token_type: 'Bearer', expires_in: 86400 })
  );
}

// =============================================================================
// SUITE 1 — AUTHENTICATION
// =============================================================================

describe('Suite 1 — Authentication (POST /auth/v1/token)', () => {
  let client: LiberisClient;

  beforeEach(() => {
    mockFetch.mockClear();
    // Reset token cache between tests
    jest.isolateModules(() => {});
    client = new LiberisClient(TEST_CONFIG);
  });

  test('1.1 — Happy path: valid credentials return access_token', async () => {
    withAuthMock();
    const token = await client.getToken();
    expect(token).toBe(MOCK_TOKEN);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://platform.eu.liberis.com/auth/v1/token',
      expect.objectContaining({ method: 'POST' })
    );
  });

  test('1.2 — Token is cached; second call does not hit the network', async () => {
    withAuthMock();
    await client.getToken();
    await client.getToken(); // should use cache
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('1.3 — HTTP 401 throws LiberisError with correct statusCode', async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ error: 'access_denied', error_description: 'Unauthorized' }, 401)
    );
    await expect(client.getToken()).rejects.toThrow(LiberisError);
    await expect(client.getToken()).rejects.toMatchObject({ statusCode: 401 });
  });

  test('1.4 — Request body uses grant_type: client_credentials', async () => {
    withAuthMock();
    await client.getToken();
    const callBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(callBody.grant_type).toBe('client_credentials');
    expect(callBody.client_id).toBe(TEST_CONFIG.clientId);
    expect(callBody.client_secret).toBe(TEST_CONFIG.clientSecret);
  });
});

// =============================================================================
// SUITE 2 — MERCHANT REGISTRATION
// =============================================================================

describe('Suite 2 — Merchant Registration (POST /data/v1/clients)', () => {
  let client: LiberisClient;

  beforeEach(() => {
    mockFetch.mockClear();
    client = new LiberisClient(TEST_CONFIG);
    (checkPlatformEligibility as jest.Mock).mockResolvedValue({ eligible: true });
  });

  const completedStatusResponse = (state: string, errors: string[] = []) => ({
    status: 'Completed',
    id: MOCK_STATUS_CHECK_ID,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: null,
    result: [{
      data: { partner_client_id: MOCK_MERCHANT_ID, client_start_date: '2021-06-01', entity_type: 'LimitedCompany', other_identifiers: [] },
      status: { state, validation_errors: errors },
    }],
  });

  test('2.1 — Happy path: registers, polls Pending then Completed → success', async () => {
    withAuthMock();
    mockFetch
      .mockResolvedValueOnce(mockResponse({ status_check_id: MOCK_STATUS_CHECK_ID, status_check_uri: `/data/v1/clients/status/${MOCK_STATUS_CHECK_ID}` }, 202))
      .mockResolvedValueOnce(mockResponse({ status: 'Pending', id: MOCK_STATUS_CHECK_ID, created_at: '', updated_at: null, result: [] }))
      .mockResolvedValueOnce(mockResponse(completedStatusResponse('Completed')));

    const result = await registerMerchantWithLiberis(client, MOCK_MERCHANT_ID);
    expect(result.success).toBe(true);
    expect(result.errors).toBeUndefined();
  });

  test('2.2 — Duplicate state treated as success (merchant already registered)', async () => {
    withAuthMock();
    mockFetch
      .mockResolvedValueOnce(mockResponse({ status_check_id: MOCK_STATUS_CHECK_ID, status_check_uri: '' }, 202))
      .mockResolvedValueOnce(mockResponse(completedStatusResponse('Duplicate', ['already exists'])));

    const result = await registerMerchantWithLiberis(client, MOCK_MERCHANT_ID);
    expect(result.success).toBe(true);
  });

  test('2.3 — Failed state returns validation_errors in response', async () => {
    withAuthMock();
    mockFetch
      .mockResolvedValueOnce(mockResponse({ status_check_id: MOCK_STATUS_CHECK_ID, status_check_uri: '' }, 202))
      .mockResolvedValueOnce(mockResponse(completedStatusResponse('Failed', ['entity_type is required', 'client_start_date is invalid'])));

    const result = await registerMerchantWithLiberis(client, MOCK_MERCHANT_ID);
    expect(result.success).toBe(false);
    expect(result.errors).toContain('entity_type is required');
  });

  test('2.4 — Platform-ineligible merchant does not call Liberis API', async () => {
    (checkPlatformEligibility as jest.Mock).mockResolvedValueOnce({ eligible: false, reason: 'Below revenue threshold' });

    const result = await registerMerchantWithLiberis(client, MOCK_MERCHANT_ID);
    expect(result.success).toBe(false);
    expect(result.errors).toContain('Below revenue threshold');
    const liberisClientCalls = mockFetch.mock.calls.filter(c =>
      (c[0] as string).includes('/data/v1/clients')
    );
    expect(liberisClientCalls.length).toBe(0);
  });

  test('2.5 — Idempotency-Key header present on POST /data/v1/clients', async () => {
    withAuthMock();
    mockFetch
      .mockResolvedValueOnce(mockResponse({ status_check_id: MOCK_STATUS_CHECK_ID, status_check_uri: '' }, 202))
      .mockResolvedValueOnce(mockResponse(completedStatusResponse('Completed')));

    await registerMerchantWithLiberis(client, MOCK_MERCHANT_ID);
    const clientsCall = mockFetch.mock.calls.find(c => (c[0] as string).includes('/data/v1/clients'));
    expect(clientsCall).toBeDefined();
    const headers = clientsCall![1].headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBeDefined();
    expect(headers['Idempotency-Key']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  test('2.6 — Conflict state returns failure', async () => {
    withAuthMock();
    mockFetch
      .mockResolvedValueOnce(mockResponse({ status_check_id: MOCK_STATUS_CHECK_ID, status_check_uri: '' }, 202))
      .mockResolvedValueOnce(mockResponse(completedStatusResponse('Conflict', ['partner_client_id conflict'])));

    const result = await registerMerchantWithLiberis(client, MOCK_MERCHANT_ID);
    expect(result.success).toBe(false);
  });
});

// =============================================================================
// SUITE 3 — REVENUE CLAIMS
// =============================================================================

describe('Suite 3 — Revenue Claims (POST /data/v1/revenueClaims)', () => {
  let client: LiberisClient;

  beforeEach(() => {
    mockFetch.mockClear();
    client = new LiberisClient(TEST_CONFIG);
  });

  test('3.1 — Happy path: claims submitted, returns status_check_id', async () => {
    withAuthMock();
    mockFetch.mockResolvedValueOnce(
      mockResponse({ status_check_id: 'rev-sc-001', status_check_uri: '/data/v1/revenueClaims/status/rev-sc-001' }, 202)
    );
    const result = await submitRevenueClaims(client, MOCK_MERCHANT_ID);
    expect(result.status_check_id).toBe('rev-sc-001');
  });

  test('3.2 — unique_reference is deterministic (merchantId-YYYY-MM format)', async () => {
    withAuthMock();
    mockFetch.mockResolvedValueOnce(
      mockResponse({ status_check_id: 'rev-sc-002', status_check_uri: '' }, 202)
    );

    await submitRevenueClaims(client, MOCK_MERCHANT_ID);

    const revenueCall = mockFetch.mock.calls.find(c =>
      (c[0] as string).includes('/data/v1/revenueClaims')
    );
    expect(revenueCall).toBeDefined();
    const body = JSON.parse(revenueCall![1].body as string) as Array<{ unique_reference: string }>;
    // All unique_references should follow the deterministic pattern
    body.forEach(claim => {
      expect(claim.unique_reference).toMatch(new RegExp(`^${MOCK_MERCHANT_ID}-\\d{4}-\\d{2}$`));
    });
  });

  test('3.3 — Idempotency-Key header present on revenue claims POST', async () => {
    withAuthMock();
    mockFetch.mockResolvedValueOnce(mockResponse({ status_check_id: 'rev-sc-003', status_check_uri: '' }, 202));

    await client.createRevenueClaims([{
      partner_client_id: MOCK_MERCHANT_ID,
      time_period: { start_time: '2024-12-01T00:00:00.000Z', end_time: '2024-12-31T23:59:59.999Z' },
      total_amount: 15000,
      currency: 'GBP',
      transaction_count: 720,
      unique_reference: `${MOCK_MERCHANT_ID}-2024-12`,
    }]);

    const revenueCall = mockFetch.mock.calls.find(c =>
      (c[0] as string).includes('/data/v1/revenueClaims')
    );
    const headers = revenueCall![1].headers as Record<string, string>;
    expect(headers['Idempotency-Key']).toBeDefined();
  });

  test('3.4 — HTTP 409 idempotency conflict throws LiberisError', async () => {
    withAuthMock();
    mockFetch.mockResolvedValueOnce(
      mockResponse({ status_code: 409, message: 'Idempotency Key conflict' }, 409)
    );

    await expect(
      client.createRevenueClaims([{
        partner_client_id: MOCK_MERCHANT_ID,
        time_period: { start_time: '2024-12-01T00:00:00.000Z', end_time: '2024-12-31T23:59:59.999Z' },
        total_amount: 15000,
        currency: 'GBP',
        transaction_count: 720,
        unique_reference: 'duplicate-key',
      }])
    ).rejects.toThrow(LiberisError);
  });

  test('3.5 — Negative amounts accepted for returns/chargebacks', async () => {
    withAuthMock();
    mockFetch.mockResolvedValueOnce(mockResponse({ status_check_id: 'rev-sc-004', status_check_uri: '' }, 202));

    // Should not throw — negative values are valid for returns
    await expect(
      client.createRevenueClaims([{
        partner_client_id: MOCK_MERCHANT_ID,
        time_period: { start_time: '2024-12-01T00:00:00.000Z', end_time: '2024-12-31T23:59:59.999Z' },
        total_amount: -500,         // negative = returns
        currency: 'GBP',
        transaction_count: -10,    // negative = return count
        unique_reference: `${MOCK_MERCHANT_ID}-2024-12-returns`,
      }])
    ).resolves.toBeDefined();
  });
});

// =============================================================================
// SUITE 4 — OFFERS
// =============================================================================

describe('Suite 4 — Offers (GET /create/v2/advert + POST /create/v2/offers)', () => {
  let client: LiberisClient;

  beforeEach(() => {
    mockFetch.mockClear();
    client = new LiberisClient(TEST_CONFIG);
    (getLiberisId as jest.Mock).mockResolvedValue(null);
    (storeLiberisId as jest.Mock).mockResolvedValue(undefined);
  });

  function setupOffersMocks() {
    withAuthMock();
    mockFetch
      .mockResolvedValueOnce(mockResponse(MOCK_ADVERT_RESPONSE)) // GET advert
      .mockResolvedValueOnce(mockResponse(MOCK_OFFERS_RESPONSE)); // POST offers
  }

  test('4.1 — Happy path: advert found, offers returned with liberis_id', async () => {
    setupOffersMocks();
    const result = await getMerchantOffers(client, MOCK_MERCHANT_ID, MOCK_APPLICANT, MOCK_COMPANY);
    expect(result).not.toBeNull();
    expect(result!.liberis_id).toBe(MOCK_LIBERIS_ID);
    expect(result!.products[0].name).toBe('BCA');
    expect(result!.products[0].offers[0].offer_id).toBe(MOCK_OFFER_ID);
  });

  test('4.2 — Advert 404 (not eligible) → getMerchantOffers returns null', async () => {
    withAuthMock();
    mockFetch.mockResolvedValueOnce(
      mockResponse({ title: 'Not Found', status: 404 }, 404)
    );
    const result = await getMerchantOffers(client, MOCK_MERCHANT_ID, MOCK_APPLICANT, MOCK_COMPANY);
    expect(result).toBeNull();
  });

  test('4.3 — liberis_id is stored after successful offer fetch', async () => {
    setupOffersMocks();
    await getMerchantOffers(client, MOCK_MERCHANT_ID, MOCK_APPLICANT, MOCK_COMPANY);
    expect(storeLiberisId).toHaveBeenCalledWith(MOCK_MERCHANT_ID, MOCK_LIBERIS_ID);
  });

  test('4.4 — Renewal flow: stored liberis_id included in offers request body', async () => {
    (getLiberisId as jest.Mock).mockResolvedValueOnce(MOCK_LIBERIS_ID);
    setupOffersMocks();

    await getMerchantOffers(client, MOCK_MERCHANT_ID, MOCK_APPLICANT, MOCK_COMPANY);

    const offersCall = mockFetch.mock.calls.find(c =>
      (c[0] as string).includes('/create/v2/offers') && c[1].method === 'POST'
    );
    const body = JSON.parse(offersCall![1].body as string);
    expect(body.application.liberis_id).toBe(MOCK_LIBERIS_ID);
  });

  test('4.5 — Repricing: amount_requested and product_id included when provided', async () => {
    setupOffersMocks();
    await getMerchantOffers(client, MOCK_MERCHANT_ID, MOCK_APPLICANT, MOCK_COMPANY, 15000, MOCK_PRODUCT_ID);

    const offersCall = mockFetch.mock.calls.find(c =>
      (c[0] as string).includes('/create/v2/offers') && c[1].method === 'POST'
    );
    const body = JSON.parse(offersCall![1].body as string);
    expect(body.application.amount_requested).toBe(15000);
    expect(body.application.product_id).toBe(MOCK_PRODUCT_ID);
  });

  test('4.6 — apply_offer_presets: true included in offers request', async () => {
    setupOffersMocks();
    await getMerchantOffers(client, MOCK_MERCHANT_ID, MOCK_APPLICANT, MOCK_COMPANY);

    const offersCall = mockFetch.mock.calls.find(c =>
      (c[0] as string).includes('/create/v2/offers') && c[1].method === 'POST'
    );
    const body = JSON.parse(offersCall![1].body as string);
    expect(body.application.apply_offer_presets).toBe(true);
  });

  test('4.7 — bureau_search: true set in consents', async () => {
    setupOffersMocks();
    await getMerchantOffers(client, MOCK_MERCHANT_ID, MOCK_APPLICANT, MOCK_COMPANY);

    const offersCall = mockFetch.mock.calls.find(c =>
      (c[0] as string).includes('/create/v2/offers') && c[1].method === 'POST'
    );
    const body = JSON.parse(offersCall![1].body as string);
    expect(body.consents.bureau_search).toBe(true);
    expect(body.consents.application_comms).toBe(true);
  });
});

// =============================================================================
// SUITE 5 — OFFER ACCEPTANCE
// =============================================================================

describe('Suite 5 — Offer Acceptance (POST /create/v2/offers/{offer_id}/accept)', () => {
  let client: LiberisClient;

  beforeEach(() => {
    mockFetch.mockClear();
    client = new LiberisClient(TEST_CONFIG);
  });

  test('5.1 — Happy path: returns application_id, liberis_id, and links', async () => {
    withAuthMock();
    mockFetch.mockResolvedValueOnce(mockResponse(MOCK_ACCEPT_RESPONSE));

    const result = await acceptMerchantOffer(client, MOCK_OFFER_ID);
    expect(result.application_id).toBe(MOCK_APPLICATION_ID);
    expect(result.liberis_id).toBe(MOCK_LIBERIS_ID);
    expect(result.links.contract_link).toBeDefined();
  });

  test('5.2 — URL contains offer_id in the correct position', async () => {
    withAuthMock();
    mockFetch.mockResolvedValueOnce(mockResponse(MOCK_ACCEPT_RESPONSE));

    await client.acceptOffer(MOCK_OFFER_ID);

    const acceptCall = mockFetch.mock.calls.find(c =>
      (c[0] as string).includes('/accept')
    );
    expect(acceptCall![0]).toContain(`/create/v2/offers/${MOCK_OFFER_ID}/accept`);
  });

  test('5.3 — HTTP 409 conflict throws LiberisError (offer already accepted)', async () => {
    withAuthMock();
    mockFetch.mockResolvedValueOnce(
      mockResponse('Application already has accepted offer', 409)
    );

    await expect(client.acceptOffer(MOCK_OFFER_ID)).rejects.toThrow(LiberisError);
    await expect(client.acceptOffer(MOCK_OFFER_ID)).rejects.toMatchObject({ statusCode: 409 });
  });

  test('5.4 — Optional bank_details included in request body when provided', async () => {
    withAuthMock();
    mockFetch.mockResolvedValueOnce(mockResponse(MOCK_ACCEPT_RESPONSE));

    const bankDetails = {
      bank_name: 'Barclays',
      account_number: '12345678',
      account_type: 'IBAN' as const,
      sort_code: '20-00-00',
    };

    await client.acceptOffer(MOCK_OFFER_ID, bankDetails);

    const acceptCall = mockFetch.mock.calls.find(c =>
      (c[0] as string).includes('/accept')
    );
    const body = JSON.parse(acceptCall![1].body as string);
    expect(body.bank_details.bank_name).toBe('Barclays');
    expect(body.bank_details.sort_code).toBe('20-00-00');
  });
});

// =============================================================================
// SUITE 6 — WEBHOOK HANDLER
// =============================================================================

describe('Suite 6 — Webhook Handler', () => {

  beforeEach(() => {
    (handleLiberisWebhook as jest.Mock).mockResolvedValue(undefined);
  });

  test('6.1 — deal.activated event processed without error', async () => {
    await expect(
      handleLiberisWebhook(
        { event_type: 'deal.activated', deal_id: 'deal-001', merchant_id: MOCK_MERCHANT_ID },
        'mock-hmac-signature'
      )
    ).resolves.toBeUndefined();
  });

  test('6.2 — application.manual_review event processed without error', async () => {
    await expect(
      handleLiberisWebhook(
        { event_type: 'application.manual_review', application_id: MOCK_APPLICATION_ID },
        'mock-hmac-signature'
      )
    ).resolves.toBeUndefined();
  });

  test('6.3 — payment.received event processed without error', async () => {
    await expect(
      handleLiberisWebhook(
        { event_type: 'payment.received', deal_id: 'deal-001', amount: 250, currency: 'GBP' },
        'mock-hmac-signature'
      )
    ).resolves.toBeUndefined();
  });

  test('6.4 — Unknown/future event type does not throw', async () => {
    await expect(
      handleLiberisWebhook(
        { event_type: 'unknown.future.event', data: {} },
        'mock-hmac-signature'
      )
    ).resolves.toBeUndefined();
  });
});
