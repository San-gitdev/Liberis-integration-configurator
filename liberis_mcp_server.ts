/**
 * =============================================================================
 * liberis_mcp_server.ts
 * =============================================================================
 * Liberis Capital Platform v3 — MCP Server
 *
 * This server runs on YOUR infrastructure at YOUR cost.
 * Each partner deploys their own instance — no shared tenancy,
 * no data crossing partner boundaries.
 *
 * Quick-start:
 *   npm install
 *   cp .env.example .env          # fill in your credentials
 *   npx ts-node liberis_mcp_server.ts
 *
 * Then add to your MCP client config (see README / configurator app).
 *
 * -----------------------------------------------------------------------------
 * TOOLS EXPOSED TO YOUR MCP CLIENT
 * -----------------------------------------------------------------------------
 *
 *  register_merchant       Onboard a merchant with Liberis
 *  submit_revenue          Push 12 months of revenue data (run daily)
 *  check_eligibility       Check if a merchant can see financing
 *  get_offers              Fetch underwritten offers for a merchant
 *  reprice_offer           Adjust an offer to a custom amount
 *  accept_offer            Lock a merchant's chosen offer
 *  get_balance             Get outstanding balance for an active deal
 *  run_onboarding_flow     Full end-to-end: register → revenue → eligibility
 *  list_tools              Describe all available tools (meta)
 *
 * -----------------------------------------------------------------------------
 * PARTNER ADAPTERS — REPLACE THESE
 * -----------------------------------------------------------------------------
 * Functions marked // ADAPTER must be replaced with real calls to your
 * platform's API. Each one documents the expected contract.
 * =============================================================================
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import * as http from 'http';

// =============================================================================
// CONFIGURATION — loaded from environment variables
// =============================================================================

const CONFIG = {
  // Liberis credentials — get these from your Liberis partner manager
  liberisClientId:     process.env.LIBERIS_CLIENT_ID     ?? '',
  liberisClientSecret: process.env.LIBERIS_CLIENT_SECRET ?? '',
  liberisBaseUrl:      process.env.LIBERIS_BASE_URL      ?? 'https://platform.eu.liberis.com',
  liberisEnv:          process.env.LIBERIS_ENV           ?? 'sandbox',

  // Your platform details — used in adapter calls and logging
  partnerName:         process.env.PARTNER_NAME          ?? 'MyPlatform',
  partnerCurrency:     process.env.PARTNER_CURRENCY      ?? 'GBP',

  // Transport: 'stdio' for Claude Desktop / Cursor, 'sse' for HTTP-based clients
  transport:           process.env.MCP_TRANSPORT         ?? 'stdio',
  port:                parseInt(process.env.MCP_PORT     ?? '3000'),

  // Policy — loaded from env or your policy store
  productsEnabled:     (process.env.PRODUCTS_ENABLED     ?? 'bca,renewal').split(','),
  minMonths:           parseInt(process.env.MIN_MONTHS   ?? '3'),
  minRevenue:          parseInt(process.env.MIN_REVENUE  ?? '2000'),
  applyOfferPresets:   process.env.APPLY_OFFER_PRESETS   !== 'false',
};

// =============================================================================
// TOKEN CACHE
// =============================================================================

let _tokenCache: { access_token: string; expiresAt: number } | null = null;

async function getToken(): Promise<string> {
  const now = Date.now();
  if (_tokenCache && _tokenCache.expiresAt > now) return _tokenCache.access_token;

  const res = await fetch(`${CONFIG.liberisBaseUrl}/auth/v1/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id:     CONFIG.liberisClientId,
      client_secret: CONFIG.liberisClientSecret,
      grant_type:    'client_credentials',
    }),
  });
  if (!res.ok) throw new Error(`Auth failed: ${res.status} ${await res.text()}`);
  const data = await res.json() as { access_token: string; expires_in: number };
  _tokenCache = { access_token: data.access_token, expiresAt: now + (data.expires_in - 3600) * 1000 };
  return data.access_token;
}

async function authHeaders(): Promise<Record<string, string>> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${await getToken()}` };
}

// =============================================================================
// LIBERIS API CALLS — thin wrappers around v3 endpoints
// =============================================================================

async function liberisPost(path: string, body: unknown, idempotent = true): Promise<unknown> {
  const headers = await authHeaders();
  if (idempotent) headers['Idempotency-Key'] = randomUUID();
  const res = await fetch(`${CONFIG.liberisBaseUrl}${path}`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Liberis ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function liberisGet(path: string): Promise<unknown> {
  const res = await fetch(`${CONFIG.liberisBaseUrl}${path}`, { headers: await authHeaders() });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Liberis ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function pollStatus(statusCheckId: string, endpoint: string): Promise<unknown> {
  for (let i = 0; i < 12; i++) {
    const data = await liberisGet(`${endpoint}/${statusCheckId}`) as { status: string; result?: unknown[] };
    if (data && data.status === 'Completed') return data;
    await new Promise(r => setTimeout(r, Math.min(2000 * Math.pow(1.5, i), 15000))); // exponential backoff
  }
  throw new Error(`Polling timed out for ${statusCheckId}`);
}

// =============================================================================
// PARTNER ADAPTERS
// Replace each function with a real call to your platform's API.
// =============================================================================

/**
 * ADAPTER: Fetch merchant profile from your platform.
 *
 * Must return: { partnerId, entityType, clientStartDate, legalName,
 *   address: { line1, town_city, postcode, country }, email?, phone?,
 *   dateOfBirth?, registrationNumber? }
 *
 * entityType must use Liberis taxonomy:
 *   SoleTrader | LimitedCompany | LLC | LLP | Partnership | SoleProprietor
 */
async function getPlatformMerchant(merchantId: string): Promise<Record<string, unknown>> {
  // ADAPTER — replace with your real API call
  // Example: const res = await fetch(`https://api.yourplatform.com/merchants/${merchantId}`);
  console.error(`[ADAPTER] getPlatformMerchant(${merchantId}) — replace with real call`);
  return {
    partnerId:      merchantId,
    entityType:     'SoleTrader',
    clientStartDate: '2022-01-01',
    legalName:      'Mock Merchant Ltd',
    address: { line1: '1 Test Street', town_city: 'London', postcode: 'EC1A 1BB', country: 'UK' },
    email:   'merchant@example.com',
    phone:   '07700900000',
  };
}

/**
 * ADAPTER: Fetch 12 months of revenue data from your platform.
 *
 * Must return: Array of { date: 'YYYY-MM', amount: number,
 *   count: number, currency: string }
 *
 * Rules:
 *   - Last 12 COMPLETE months only (exclude current partial month)
 *   - Use NEGATIVE amount + count for returns/chargebacks
 */
async function getPlatformRevenue(merchantId: string): Promise<Array<Record<string, unknown>>> {
  // ADAPTER — replace with your real revenue API call
  console.error(`[ADAPTER] getPlatformRevenue(${merchantId}) — replace with real call`);
  const volumes = [];
  const now = new Date();
  for (let i = 1; i <= 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    volumes.push({
      date:   `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      amount: Math.round((8000 + Math.random() * 12000) * 100) / 100,
      count:  400 + Math.floor(Math.random() * 600),
      currency: CONFIG.partnerCurrency,
    });
  }
  return volumes;
}

/**
 * ADAPTER: Apply your platform's eligibility rules before calling Liberis.
 * Liberis runs its own underwriting on top — you can restrict further but not override.
 *
 * Must return: { eligible: boolean, reason?: string }
 */
async function checkPlatformEligibility(merchantId: string): Promise<{ eligible: boolean; reason?: string }> {
  // ADAPTER — replace with your real eligibility check
  console.error(`[ADAPTER] checkPlatformEligibility(${merchantId}) — replace with real call`);
  return { eligible: true };
}

/**
 * ADAPTER: Persist the liberis_id returned after first offer retrieval.
 * Required for renewal flows — losing this forces re-registration.
 */
async function storeLiberisId(merchantId: string, liberisId: string): Promise<void> {
  // ADAPTER — replace with your DB write
  console.error(`[ADAPTER] storeLiberisId(${merchantId}, ${liberisId}) — replace with real call`);
}

/**
 * ADAPTER: Retrieve a previously stored liberis_id.
 * Returns null for new merchants, string for returning merchants.
 */
async function getLiberisId(merchantId: string): Promise<string | null> {
  // ADAPTER — replace with your DB read
  console.error(`[ADAPTER] getLiberisId(${merchantId}) — replace with real call`);
  return null;
}

// =============================================================================
// ORCHESTRATION HELPERS
// =============================================================================

async function registerMerchant(merchantId: string): Promise<{ success: boolean; errors?: string[]; state?: string }> {
  const elig = await checkPlatformEligibility(merchantId);
  if (!elig.eligible) return { success: false, errors: [elig.reason ?? 'Platform eligibility failed'] };

  const merchant = await getPlatformMerchant(merchantId);
  const resp = await liberisPost('/data/v1/clients', [{
    partner_client_id:  merchant.partnerId,
    client_start_date:  merchant.clientStartDate,
    entity_type:        merchant.entityType,
    other_identifiers:  [{ key: 'PlatformMerchantId', values: [merchantId] }],
  }]) as { status_check_id: string };

  const status = await pollStatus(resp.status_check_id, '/data/v1/clients/status') as {
    result: Array<{ status: { state: string; validation_errors: string[] } }>
  };
  const item = status.result[0];
  if (item.status.state === 'Completed' || item.status.state === 'Duplicate') {
    return { success: true, state: item.status.state };
  }
  return { success: false, errors: item.status.validation_errors, state: item.status.state };
}

async function submitRevenue(merchantId: string): Promise<{ status_check_id: string }> {
  const volumes = await getPlatformRevenue(merchantId);
  const claims = volumes.map(v => ({
    partner_client_id: merchantId,
    time_period: {
      start_time: `${v.date}-01T00:00:00.000Z`,
      end_time:   new Date(new Date(`${v.date}-01`).setMonth(new Date(`${v.date}-01`).getMonth() + 1) - 1).toISOString(),
    },
    total_amount:      v.amount,
    currency:          v.currency,
    transaction_count: v.count,
    unique_reference:  `${merchantId}-${v.date}`,
  }));
  return liberisPost('/data/v1/revenueClaims', claims) as Promise<{ status_check_id: string }>;
}

async function fetchOffers(
  merchantId: string,
  merchant: Record<string, unknown>,
  volumes: Array<Record<string, unknown>>,
  amountRequested?: number,
  productId?: string,
): Promise<unknown> {
  const liberisId = await getLiberisId(merchantId);
  const payload = {
    application: {
      merchant_id:          merchantId,
      currency:             CONFIG.partnerCurrency,
      apply_offer_presets:  CONFIG.applyOfferPresets,
      intended_use_of_funds: 'Cash Flow',
      ...(liberisId       && { liberis_id: liberisId }),
      ...(amountRequested && { amount_requested: amountRequested }),
      ...(productId       && { product_id: productId }),
    },
    consents: { bureau_search: true, application_comms: true },
    applicants: [{
      first_name:         String(merchant.legalName ?? '').split(' ')[0] || 'Owner',
      last_name:          String(merchant.legalName ?? '').split(' ').slice(1).join(' ') || 'Unknown',
      email_address:      merchant.email ?? 'unknown@example.com',
      telephone_number:   merchant.phone ?? '00000000000',
      date_of_birth:      merchant.dateOfBirth ?? '1980-01-01',
      primary:            true,
      ownership_percentage: 100,
    }],
    company: {
      legal_name:          merchant.legalName,
      business_type:       merchant.entityType,
      business_start_date: merchant.clientStartDate,
      partner_start_date:  merchant.clientStartDate,
      industry:            'General',
      registration_number: merchant.registrationNumber,
      registered_address:  merchant.address,
      payment_channels: [{
        name:     CONFIG.partnerName,
        reference: merchantId,
        type:     'Card Processor',
        primary:  true,
        existing_split: false,
        monthly_volumes: volumes.map(v => ({ date: v.date, amount: v.amount, count: v.count, currency: v.currency })),
      }],
    },
  };
  const offers = await liberisPost('/create/v2/offers', payload, false) as { liberis_id: string };
  await storeLiberisId(merchantId, offers.liberis_id);
  return offers;
}

// =============================================================================
// MCP SERVER SETUP
// =============================================================================

const server = new McpServer({
  name:    'liberis-integration',
  version: '2.0.0',
});

// ── TOOL: register_merchant ──────────────────────────────────────────────────
server.tool(
  'register_merchant',
  'Register a merchant with Liberis. Checks platform eligibility, sends merchant profile, polls until validated. Call this before any offer flow.',
  {
    merchant_id: z.string().describe('Your internal merchant ID'),
  },
  async ({ merchant_id }) => {
    try {
      const result = await registerMerchant(merchant_id);
      return {
        content: [{
          type: 'text',
          text: result.success
            ? `✓ Merchant ${merchant_id} registered successfully (state: ${result.state})`
            : `✗ Registration failed: ${result.errors?.join(', ')}`,
        }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }
);

// ── TOOL: submit_revenue ─────────────────────────────────────────────────────
server.tool(
  'submit_revenue',
  'Submit 12 months of revenue claims for a merchant. Run this daily for all active merchants. Must be called before get_offers for new merchants.',
  {
    merchant_id: z.string().describe('Your internal merchant ID'),
  },
  async ({ merchant_id }) => {
    try {
      const result = await submitRevenue(merchant_id);
      return {
        content: [{
          type: 'text',
          text: `✓ Revenue submitted for ${merchant_id}. Status check ID: ${result.status_check_id}`,
        }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }
);

// ── TOOL: check_eligibility ──────────────────────────────────────────────────
server.tool(
  'check_eligibility',
  'Check whether a merchant is eligible to see financing offers. Returns eligible status and advert copy if eligible. Use this to decide whether to show the financing banner.',
  {
    merchant_id: z.string().describe('Your internal merchant ID'),
    locale:      z.string().optional().describe('Optional locale code e.g. en-GB'),
  },
  async ({ merchant_id, locale }) => {
    try {
      const path = `/create/v2/advert/${merchant_id}${locale ? `?locale=${locale}` : ''}`;
      const advert = await liberisGet(path);
      if (!advert) {
        return { content: [{ type: 'text', text: `Merchant ${merchant_id} is not eligible for financing at this time.` }] };
      }
      const a = advert as { advert_data: { header: string; call_to_action: string; offer_status: string } };
      return {
        content: [{
          type: 'text',
          text: `✓ Eligible. Advert: "${a.advert_data.header}" | CTA: "${a.advert_data.call_to_action}" | Status: ${a.advert_data.offer_status}`,
        }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }
);

// ── TOOL: get_offers ─────────────────────────────────────────────────────────
server.tool(
  'get_offers',
  'Fetch underwritten financing offers for a merchant. Automatically uses stored liberis_id for returning merchants (renewal flow). Returns all available product offers with amounts, factor rates, and split percentages.',
  {
    merchant_id: z.string().describe('Your internal merchant ID'),
  },
  async ({ merchant_id }) => {
    try {
      const advert = await liberisGet(`/create/v2/advert/${merchant_id}`);
      if (!advert) return { content: [{ type: 'text', text: `Merchant ${merchant_id} is not eligible for financing.` }] };

      const merchant = await getPlatformMerchant(merchant_id);
      const volumes  = await getPlatformRevenue(merchant_id);
      const offers   = await fetchOffers(merchant_id, merchant, volumes) as {
        liberis_id: string;
        expires_at: string;
        products:   Array<{
          name: string;
          offers: Array<{ offer_id: string; funded_amount: number; factor_rate: number; split_percentage: number; currency: string }>;
        }>;
      };

      const lines = [`✓ Offers for merchant ${merchant_id} (liberis_id: ${offers.liberis_id}):`];
      for (const product of offers.products) {
        for (const offer of product.offers) {
          lines.push(
            `  [${product.name}] ${offer.currency}${offer.funded_amount.toLocaleString()} @ ${offer.factor_rate}x factor — ${offer.split_percentage}% split | offer_id: ${offer.offer_id}`
          );
        }
      }
      lines.push(`  Expires: ${offers.expires_at}`);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }
);

// ── TOOL: reprice_offer ──────────────────────────────────────────────────────
server.tool(
  'reprice_offer',
  'Re-call the offers endpoint with a specific amount to get a repriced offer. Use when a merchant wants to adjust the advance amount from the default presets.',
  {
    merchant_id:      z.string().describe('Your internal merchant ID'),
    amount_requested: z.number().describe('The advance amount the merchant wants'),
    product_id:       z.string().describe('product_id from the original get_offers response'),
  },
  async ({ merchant_id, amount_requested, product_id }) => {
    try {
      const merchant = await getPlatformMerchant(merchant_id);
      const volumes  = await getPlatformRevenue(merchant_id);
      const offers   = await fetchOffers(merchant_id, merchant, volumes, amount_requested, product_id) as {
        products: Array<{
          name: string;
          offers: Array<{ offer_id: string; funded_amount: number; factor_rate: number; split_percentage: number; currency: string }>;
        }>;
      };

      const lines = [`✓ Repriced offers for ${merchant_id} at ${CONFIG.partnerCurrency}${amount_requested.toLocaleString()}:`];
      for (const product of offers.products) {
        for (const offer of product.offers) {
          lines.push(`  [${product.name}] ${offer.currency}${offer.funded_amount.toLocaleString()} @ ${offer.factor_rate}x | offer_id: ${offer.offer_id}`);
        }
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }
);

// ── TOOL: accept_offer ───────────────────────────────────────────────────────
server.tool(
  'accept_offer',
  'Accept a merchant\'s chosen offer and begin fulfilment. This is irreversible — the offer is locked and Liberis begins the application pipeline. Subsequent updates arrive via webhooks.',
  {
    offer_id:    z.string().describe('offer_id from the get_offers or reprice_offer response'),
    bank_name:   z.string().optional().describe('Bank name (optional — speeds disbursement)'),
    sort_code:   z.string().optional().describe('Sort code (UK, optional)'),
    account_num: z.string().optional().describe('Account number (optional)'),
  },
  async ({ offer_id, bank_name, sort_code, account_num }) => {
    try {
      const bankDetails = bank_name ? {
        bank_name,
        account_number: account_num ?? '',
        account_type:   'NONE' as const,
        ...(sort_code && { sort_code }),
      } : undefined;

      const result = await liberisPost(
        `/create/v2/offers/${offer_id}/accept`,
        bankDetails ? { bank_details: bankDetails } : {},
        false
      ) as { application_id: string; liberis_id: string; links: { contract_link?: string } };

      return {
        content: [{
          type: 'text',
          text: [
            `✓ Offer accepted.`,
            `  application_id: ${result.application_id}`,
            `  liberis_id: ${result.liberis_id}`,
            result.links.contract_link ? `  contract_link: ${result.links.contract_link}` : '',
            `  Next: deal status updates will arrive via webhooks.`,
          ].filter(Boolean).join('\n'),
        }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }
);

// ── TOOL: get_balance ────────────────────────────────────────────────────────
server.tool(
  'get_balance',
  'Get the current outstanding balance and repayment split percentage for a merchant with an active deal.',
  {
    merchant_id: z.string().describe('Your internal merchant ID'),
  },
  async ({ merchant_id }) => {
    try {
      const balance = await liberisGet(`/create/v2/balance/${merchant_id}`) as {
        outstanding_balance: number;
        currency: string;
        split_percentage: number;
        deal_id: string;
      } | null;

      if (!balance) return { content: [{ type: 'text', text: `No active deal found for merchant ${merchant_id}.` }] };
      return {
        content: [{
          type: 'text',
          text: `✓ Balance for ${merchant_id}: ${balance.currency}${balance.outstanding_balance.toLocaleString()} outstanding | ${balance.split_percentage}% split | deal_id: ${balance.deal_id}`,
        }],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
    }
  }
);

// ── TOOL: run_onboarding_flow ────────────────────────────────────────────────
server.tool(
  'run_onboarding_flow',
  'Run the complete onboarding sequence for a merchant: register → submit revenue → check eligibility → get offers. Returns a full status report. Use this to onboard a new merchant end-to-end.',
  {
    merchant_id: z.string().describe('Your internal merchant ID'),
  },
  async ({ merchant_id }) => {
    const steps: string[] = [];
    try {
      steps.push(`Starting onboarding flow for merchant: ${merchant_id}`);
      steps.push(`Environment: ${CONFIG.liberisEnv} | Base URL: ${CONFIG.liberisBaseUrl}`);
      steps.push('');

      // Step 1: Register
      steps.push('Step 1/4: Registering merchant with Liberis...');
      const reg = await registerMerchant(merchant_id);
      steps.push(reg.success
        ? `  ✓ Registered (${reg.state})`
        : `  ✗ Failed: ${reg.errors?.join(', ')}`
      );
      if (!reg.success) {
        return { content: [{ type: 'text', text: steps.join('\n') }] };
      }

      // Step 2: Revenue
      steps.push('Step 2/4: Submitting revenue data...');
      const rev = await submitRevenue(merchant_id);
      steps.push(`  ✓ Revenue submitted (status_check_id: ${rev.status_check_id})`);

      // Step 3: Eligibility
      steps.push('Step 3/4: Checking eligibility...');
      const advert = await liberisGet(`/create/v2/advert/${merchant_id}`);
      if (!advert) {
        steps.push('  ✗ Not eligible for financing at this time.');
        return { content: [{ type: 'text', text: steps.join('\n') }] };
      }
      const a = advert as { advert_data: { offer_status: string; header: string } };
      steps.push(`  ✓ Eligible — "${a.advert_data.header}" (${a.advert_data.offer_status})`);

      // Step 4: Offers
      steps.push('Step 4/4: Fetching underwritten offers...');
      const merchant = await getPlatformMerchant(merchant_id);
      const volumes  = await getPlatformRevenue(merchant_id);
      const offers   = await fetchOffers(merchant_id, merchant, volumes) as {
        liberis_id: string;
        expires_at: string;
        products:   Array<{
          name: string;
          offers: Array<{ offer_id: string; funded_amount: number; factor_rate: number; split_percentage: number; currency: string }>;
        }>;
      };
      steps.push(`  ✓ ${offers.products.length} product(s) available:`);
      for (const product of offers.products) {
        for (const offer of product.offers) {
          steps.push(`    [${product.name}] ${offer.currency}${offer.funded_amount.toLocaleString()} @ ${offer.factor_rate}x | offer_id: ${offer.offer_id}`);
        }
      }
      steps.push('');
      steps.push(`✓ Onboarding complete. liberis_id: ${offers.liberis_id}`);
      steps.push(`  Next: present offers to merchant. Use accept_offer with the offer_id above.`);

      return { content: [{ type: 'text', text: steps.join('\n') }] };
    } catch (e) {
      steps.push(`✗ Error at step: ${(e as Error).message}`);
      return { content: [{ type: 'text', text: steps.join('\n') }], isError: true };
    }
  }
);

// ── TOOL: list_tools ─────────────────────────────────────────────────────────
server.tool(
  'list_tools',
  'List all available Liberis MCP tools with descriptions and usage guidance.',
  {},
  async () => ({
    content: [{
      type: 'text',
      text: [
        `Liberis Integration MCP Server v2.0 — ${CONFIG.partnerName}`,
        `Environment: ${CONFIG.liberisEnv} | Base: ${CONFIG.liberisBaseUrl}`,
        `Products enabled: ${CONFIG.productsEnabled.join(', ')}`,
        '',
        'Available tools:',
        '  register_merchant(merchant_id)          — Onboard a merchant',
        '  submit_revenue(merchant_id)             — Push revenue data (run daily)',
        '  check_eligibility(merchant_id, locale?) — Check financing eligibility',
        '  get_offers(merchant_id)                 — Fetch underwritten offers',
        '  reprice_offer(merchant_id, amount, pid) — Adjust offer amount',
        '  accept_offer(offer_id, bank_details?)   — Lock and begin fulfilment',
        '  get_balance(merchant_id)                — View outstanding balance',
        '  run_onboarding_flow(merchant_id)        — Full end-to-end onboarding',
        '  list_tools()                            — This help text',
        '',
        'ADAPTER functions to replace in liberis_mcp_server.ts:',
        '  getPlatformMerchant(merchantId)   — Fetch merchant from your platform',
        '  getPlatformRevenue(merchantId)    — Fetch revenue from your platform',
        '  checkPlatformEligibility(id)      — Your platform eligibility gate',
        '  storeLiberisId(merchantId, id)    — Persist liberis_id to your DB',
        '  getLiberisId(merchantId)          — Read stored liberis_id from your DB',
      ].join('\n'),
    }],
  })
);

// =============================================================================
// TRANSPORT — stdio (Claude Desktop / Cursor) or SSE (HTTP clients)
// =============================================================================

async function main() {
  if (CONFIG.transport === 'sse') {
    // HTTP/SSE mode — for web-based MCP clients
    const httpServer = http.createServer();
    const transports = new Map<string, SSEServerTransport>();

    httpServer.on('request', async (req, res) => {
      if (req.method === 'GET' && req.url === '/sse') {
        const transport = new SSEServerTransport('/messages', res);
        transports.set(transport.sessionId, transport);
        await server.connect(transport);
        req.on('close', () => transports.delete(transport.sessionId));
      } else if (req.method === 'POST' && req.url?.startsWith('/messages')) {
        const sessionId = new URL(req.url, `http://localhost`).searchParams.get('sessionId') ?? '';
        const transport = transports.get(sessionId);
        if (transport) {
          let body = '';
          req.on('data', chunk => body += chunk);
          req.on('end', () => transport.handlePostMessage(req, res, JSON.parse(body)));
        } else {
          res.writeHead(404).end('Session not found');
        }
      } else if (req.url === '/health') {
        res.writeHead(200).end(JSON.stringify({ status: 'ok', env: CONFIG.liberisEnv }));
      } else {
        res.writeHead(404).end();
      }
    });

    httpServer.listen(CONFIG.port, () => {
      console.error(`Liberis MCP server running on port ${CONFIG.port} (SSE mode)`);
      console.error(`Health check: http://localhost:${CONFIG.port}/health`);
    });
  } else {
    // stdio mode — for Claude Desktop / Cursor
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Liberis MCP server running on stdio');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
