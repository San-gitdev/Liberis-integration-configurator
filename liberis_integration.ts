/**
 * =============================================================================
 * liberis_integration.ts
 * =============================================================================
 * Liberis Capital Platform v3 — Partner Integration Client (TypeScript)
 *
 * API Reference : https://docs.liberis.com/v3/reference
 * Endpoints used: All from official Liberis v3 OpenAPI documentation
 * Test framework : Jest (see liberis_integration.test.ts)
 * Runtime        : Node.js 18+ (uses native fetch + crypto)
 *
 * -----------------------------------------------------------------------------
 * QUICK-START: WHICH FUNCTION TO CALL FOR EACH BUSINESS CASE
 * -----------------------------------------------------------------------------
 *
 *  1. AUTHENTICATE
 *     LiberisClient.getToken()
 *     → Called automatically by all methods. You do not need to call this
 *       directly. Token is cached for 23h.
 *
 *  2. ONBOARD A MERCHANT (register with Liberis)
 *     registerMerchantWithLiberis(client, merchantId)
 *     → Checks platform eligibility, calls POST /data/v1/clients,
 *       polls GET /data/v1/clients/status/{id} until Completed.
 *
 *  3. SUBMIT REVENUE DATA (run daily)
 *     submitRevenueClaims(client, merchantId)
 *     → Fetches 12 months of revenue from your platform (MOCK),
 *       calls POST /data/v1/revenueClaims.
 *
 *  4. CHECK IF MERCHANT IS ELIGIBLE FOR FINANCING (dashboard load)
 *     LiberisClient.getAdvert(merchantId)
 *     → Calls GET /create/v2/advert/{reference}.
 *       Returns advert copy if eligible, null if not (404).
 *       Use null to hide the financing banner — do NOT expose
 *       ineligibility to the merchant.
 *
 *  5. GET UNDERWRITTEN OFFERS (merchant clicks CTA)
 *     getMerchantOffers(client, merchantId, applicant, company)
 *     → Calls POST /create/v2/offers with bureau_search: true.
 *       Automatically passes liberis_id for renewals if stored.
 *       Returns OffersResponse with product offers and factor rates.
 *
 *  6. REPRICE AN OFFER (merchant adjusts amount slider)
 *     getMerchantOffers(client, merchantId, applicant, company, amountRequested, productId)
 *     → Re-calls POST /create/v2/offers with amount_requested + product_id.
 *
 *  7. ACCEPT AN OFFER (merchant confirms)
 *     acceptMerchantOffer(client, offerId)
 *     → Calls POST /create/v2/offers/{offer_id}/accept.
 *       Subsequent updates arrive via webhooks.
 *
 *  8. VIEW BALANCE / OUTSTANDING AMOUNT (merchant dashboard)
 *     LiberisClient.getBalance(merchantId)
 *     → Calls GET /create/v2/balance/{merchant_id}.
 *       Returns current outstanding balance and active split %.
 *
 *  9. HANDLE INBOUND WEBHOOKS (deal events)
 *     handleLiberisWebhook(body, signature)
 *     → Route deal.activated / payment.received / deal.completed etc.
 *       Add HMAC-SHA256 signature verification — see MOCK below.
 *
 * -----------------------------------------------------------------------------
 * MOCK FUNCTIONS — MUST BE REPLACED
 * -----------------------------------------------------------------------------
 * All functions marked // MOCK are stubs that simulate your platform's
 * internal API calls. Replace each one with a real call to your system.
 * Each stub documents the expected contract (inputs/outputs).
 *
 * If you uploaded an OpenAPI schema in the configurator, map your detected
 * endpoints to the functions below.
 *
 * -----------------------------------------------------------------------------
 * INSTALLATION
 * -----------------------------------------------------------------------------
 *   npm install                    (no extra deps — uses native fetch/crypto)
 *   npm install -D jest ts-jest @types/jest @types/node typescript
 *
 *   tsconfig.json minimum:
 *   {
 *     "compilerOptions": {
 *       "target": "ES2022", "module": "commonjs",
 *       "lib": ["ES2022"], "strict": true, "esModuleInterop": true
 *     }
 *   }
 * =============================================================================
 */

import { randomUUID } from 'crypto';

// =============================================================================
// CONFIGURATION
// =============================================================================

export interface LiberisConfig {
  clientId: string;
  clientSecret: string;
  /**
   * Base URL determined by region:
   *   UK / EU → https://platform.eu.liberis.com
   *   US      → https://platform.us.liberis.com
   */
  baseUrl: string;
  env: 'sandbox' | 'production';
}

// =============================================================================
// TYPES — sourced directly from Liberis v3 OpenAPI definitions
// =============================================================================

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number; // 86400 seconds
}

export interface PartnerClientPayload {
  partner_client_id: string;       // your internal merchant identifier
  client_start_date: string;       // ISO date: when merchant joined your platform
  entity_type: string;             // Liberis taxonomy: SoleTrader | LimitedCompany | LLC | LLP | Partnership | SoleProprietor
  other_identifiers?: Array<{ key: string; values: string[] }>;
}

export interface ClientStatusResponse {
  status: 'Pending' | 'Completed';
  id: string;
  created_at: string;
  updated_at: string | null;
  result: Array<{
    data: PartnerClientPayload;
    status: {
      /** Pending | Completed | Duplicate | Conflict | Failed */
      state: string;
      validation_errors: string[];
    };
  }>;
}

export interface RevenueClaimPayload {
  partner_client_id: string;
  time_period: {
    start_time: string; // ISO 8601 with timezone, e.g. 2025-01-01T00:00:00.000Z
    end_time: string;
  };
  /** Positive for sales, NEGATIVE for returns/chargebacks */
  total_amount: number;
  currency: string; // e.g. 'GBP', 'USD'
  /** Positive for sales, NEGATIVE for returns/chargebacks */
  transaction_count: number;
  /** MUST be deterministic — recommended: hash of merchantId+period */
  unique_reference: string;
  is_splittable?: boolean;
  payment_channel?: { id: string; start_date: string };
}

export interface MonthlyVolume {
  date: string;       // 'YYYY-MM'
  amount: number;
  count: number;
  currency: string;
  indicative?: boolean;
}

export interface Address {
  line1: string;
  line2?: string;
  town_city: string;
  postcode: string;
  state?: string;
  /** Possible values: CZE | DE | DK | FI | GBR | IRE | ISL | SE | UK | SVK | US */
  country: string;
}

export interface Applicant {
  first_name: string;
  last_name: string;
  email_address: string;         // must be unique per applicant in the array
  telephone_number: string;
  date_of_birth: string;         // YYYY-MM-DD
  primary: boolean;              // exactly one applicant must be primary: true
  ownership_percentage: number;
  identification_number?: string; // SSN for US applicants
  residences?: Array<{
    address: Address;
    residential_status?: 'Home Owner' | 'Renting';
    primary?: boolean;           // required if multiple residences
  }>;
}

export interface PaymentChannel {
  name: string;                  // acquirer name
  reference: string;             // terminal ID
  type: 'Card Processor';
  primary: boolean;
  existing_split: boolean;
  monthly_volumes?: MonthlyVolume[];
}

export interface Company {
  legal_name: string;
  business_type: string;         // Limited Company | Sole Trader | LLC | LLP | Partnership | SoleProprietor
  business_start_date: string;   // date entity was created (NOT date joined your platform)
  partner_start_date: string;    // date merchant joined your platform
  industry: string;              // see Liberis industry taxonomy in docs
  registration_number?: string;  // REQUIRED for Limited Company / LLP
  other_revenue_source?: boolean;
  trading_addresses?: Array<{ trading_name: string; currency: string; address: Address }>;
  registered_address?: Address;
  payment_channels?: PaymentChannel[]; // use for card/acquirer revenue
  monthly_revenues?: MonthlyVolume[];  // use for open-banking / non-card revenue
  mcc?: number;                        // required for UK
}

export interface OffersRequest {
  application: {
    merchant_id: string;
    currency: string;            // 'GBP' | 'USD'
    liberis_id?: string;         // pass for renewals (from prior OffersResponse)
    amount_requested?: number;   // for custom repricing
    product_id?: string;         // required when repricing with amount_requested
    intended_use_of_funds?: string;
    apply_offer_presets?: boolean; // true = 3 curated offers, false = full range
  };
  consents: {
    bureau_search: boolean;      // true = auto-underwriting (UK only for automated decisions)
    application_comms: boolean;
  };
  applicants: Applicant[];
  company: Company;
}

export interface Offer {
  offer_id: string;
  offer_status: string;          // 'Eligible' | 'Indicative'
  description: string;
  split_percentage: number;
  term_length: number;           // months
  funded_amount: number;
  total_funded_amount: number;
  repayment_amount: number;
  total_repayment_amount: number;
  factor_rate: number;           // e.g. 1.09
  currency: string;
}

export interface ProductOffer {
  product_id: string;
  name: string;                  // 'BCA' | 'Flexi'
  description: string;
  decision: string;              // 'Accepted' | 'Declined' | 'Indicative'
  repayment_mechanism: string;   // 'terminal_split' | 'esplit'
  limits: { minimum: number; maximum: number; currency: string };
  offers: Offer[];
}

export interface OffersResponse {
  liberis_id: string;            // STORE THIS — used for renewals
  expires_at: string;
  products: ProductOffer[];
}

export interface AcceptOfferResponse {
  application_id: string;
  liberis_id: string;
  offer: Offer;
  links: {
    contract_link?: string;      // Click2Sign URL
    merchant_link?: string;      // Liberis merchant portal link
  };
}

export interface AdvertResponse {
  meta: { reference: string };
  advert_data: {
    header: string;
    title: string;
    subtitle: string;
    body: string;
    call_to_action: string;
    footer: string;
    background_image_url: string;
    offer_status: string;
    html: string;
  };
}

export interface BalanceResponse {
  merchant_id: string;
  outstanding_balance: number;
  currency: string;
  split_percentage: number;
  deal_id: string;
}

// =============================================================================
// TOKEN CACHE — module-level singleton
// =============================================================================

interface CachedToken {
  access_token: string;
  expiresAt: number; // unix ms
}

let _tokenCache: CachedToken | null = null;

// =============================================================================
// LIBERIS API CLIENT
// All methods map 1-to-1 to documented v3 API endpoints.
// =============================================================================

export class LiberisClient {
  constructor(private config: LiberisConfig) {}

  // ---------------------------------------------------------------------------
  // AUTH — POST /auth/v1/token
  // Ref: https://docs.liberis.com/reference/retrieve-token
  // ---------------------------------------------------------------------------
  async getToken(): Promise<string> {
    const now = Date.now();
    if (_tokenCache && _tokenCache.expiresAt > now) {
      return _tokenCache.access_token;
    }

    const res = await fetch(`${this.config.baseUrl}/auth/v1/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        grant_type: 'client_credentials',
      }),
    });
    if (!res.ok) {
      throw new LiberisError('getToken', res.status, await res.text());
    }
    const data: TokenResponse = await res.json();
    _tokenCache = {
      access_token: data.access_token,
      expiresAt: now + (data.expires_in - 3600) * 1000, // proactive refresh 1h early
    };
    return data.access_token;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${await this.getToken()}`,
    };
  }

  // ---------------------------------------------------------------------------
  // REGISTER MERCHANT — POST /data/v1/clients
  // Async: returns status_check_id for polling.
  // Idempotency-Key (UUID v4) is REQUIRED.
  // Ref: https://docs.liberis.com/reference/create-partner-client
  // ---------------------------------------------------------------------------
  async createPartnerClients(
    clients: PartnerClientPayload[]
  ): Promise<{ status_check_id: string; status_check_uri: string }> {
    const headers = await this.authHeaders();
    headers['Idempotency-Key'] = randomUUID();
    const res = await fetch(`${this.config.baseUrl}/data/v1/clients`, {
      method: 'POST',
      headers,
      body: JSON.stringify(clients),
    });
    if (!res.ok) {
      throw new LiberisError('createPartnerClients', res.status, await res.text());
    }
    return res.json();
  }

  // ---------------------------------------------------------------------------
  // POLL CLIENT STATUS — GET /data/v1/clients/status/{status_check_id}
  // Polls until top-level status = 'Completed'.
  // Per-item states: Pending | Completed | Duplicate | Conflict | Failed
  // Ref: https://docs.liberis.com/reference/get-partner-client-status
  // ---------------------------------------------------------------------------
  async pollClientStatus(
    statusCheckId: string,
    maxAttempts = 10,
    delayMs = 3000
  ): Promise<ClientStatusResponse> {
    for (let i = 0; i < maxAttempts; i++) {
      const res = await fetch(
        `${this.config.baseUrl}/data/v1/clients/status/${statusCheckId}`,
        { headers: await this.authHeaders() }
      );
      if (!res.ok) {
        throw new LiberisError('pollClientStatus', res.status, await res.text());
      }
      const data: ClientStatusResponse = await res.json();
      if (data.status === 'Completed') return data;
      await sleep(delayMs);
    }
    throw new Error(`pollClientStatus: timed out after ${maxAttempts} attempts`);
  }

  // ---------------------------------------------------------------------------
  // SUBMIT REVENUE CLAIMS — POST /data/v1/revenueClaims
  // - unique_reference must be DETERMINISTIC (re-creatable your side)
  // - Negative total_amount + transaction_count for returns/chargebacks
  // - Do NOT include the current partial month
  // - Daily and Monthly granularity both supported
  // Ref: https://docs.liberis.com/reference/create-partner-client-revenue
  // ---------------------------------------------------------------------------
  async createRevenueClaims(
    claims: RevenueClaimPayload[]
  ): Promise<{ status_check_id: string; status_check_uri: string }> {
    const headers = await this.authHeaders();
    headers['Idempotency-Key'] = randomUUID();
    const res = await fetch(`${this.config.baseUrl}/data/v1/revenueClaims`, {
      method: 'POST',
      headers,
      body: JSON.stringify(claims),
    });
    if (!res.ok) {
      throw new LiberisError('createRevenueClaims', res.status, await res.text());
    }
    return res.json();
  }

  // ---------------------------------------------------------------------------
  // GET ADVERT — GET /create/v2/advert/{reference}
  // Returns advert copy if merchant is eligible.
  // Returns NULL (404) if merchant is not eligible.
  // Use the null response to show/hide the banner — do NOT expose
  // ineligibility to the merchant directly.
  // Ref: https://docs.liberis.com/reference/get-advert
  // ---------------------------------------------------------------------------
  async getAdvert(merchantId: string, locale?: string): Promise<AdvertResponse | null> {
    const params = locale ? `?locale=${locale}` : '';
    const res = await fetch(
      `${this.config.baseUrl}/create/v2/advert/${merchantId}${params}`,
      { headers: await this.authHeaders() }
    );
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new LiberisError('getAdvert', res.status, await res.text());
    }
    return res.json();
  }

  // ---------------------------------------------------------------------------
  // GET OFFERS — POST /create/v2/offers
  // bureau_search: true → triggers auto-underwriting (automated decisions: UK only)
  // bureau_search: false → indicative offer only, requires manual underwriting
  // Also used for: repricing (add amount_requested + product_id)
  //                renewals  (add liberis_id from original deal)
  // Ref: https://docs.liberis.com/reference/get-offers
  // ---------------------------------------------------------------------------
  async getOffers(payload: OffersRequest): Promise<OffersResponse> {
    const res = await fetch(`${this.config.baseUrl}/create/v2/offers`, {
      method: 'POST',
      headers: await this.authHeaders(),
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      throw new LiberisError('getOffers', res.status, await res.text());
    }
    return res.json();
  }

  // ---------------------------------------------------------------------------
  // ACCEPT OFFER — POST /create/v2/offers/{offer_id}/accept
  // Locks the offer and begins fulfilment pipeline.
  // 409 Conflict = offer already accepted (idempotent by offer_id).
  // Optional bank_details speeds disbursement by reducing Liberis-merchant comms.
  // Ref: https://docs.liberis.com/reference/accept-an-offer
  // ---------------------------------------------------------------------------
  async acceptOffer(
    offerId: string,
    bankDetails?: {
      bank_name: string;
      account_number: string;
      account_type: 'NONE' | 'IBAN' | 'LOCAL_SE' | 'PLUSGIRO' | 'BANKGIRO';
      sort_code?: string;
      routing_number?: string;
    }
  ): Promise<AcceptOfferResponse> {
    const res = await fetch(
      `${this.config.baseUrl}/create/v2/offers/${offerId}/accept`,
      {
        method: 'POST',
        headers: await this.authHeaders(),
        body: JSON.stringify(bankDetails ? { bank_details: bankDetails } : {}),
      }
    );
    if (!res.ok) {
      throw new LiberisError('acceptOffer', res.status, await res.text());
    }
    return res.json();
  }

  // ---------------------------------------------------------------------------
  // GET BALANCE — GET /create/v2/balance/{merchant_id}
  // Returns current outstanding balance and repayment split % for active deal.
  // Call on merchant dashboard load to surface repayment progress.
  // ---------------------------------------------------------------------------
  async getBalance(merchantId: string): Promise<BalanceResponse> {
    const res = await fetch(
      `${this.config.baseUrl}/create/v2/balance/${merchantId}`,
      { headers: await this.authHeaders() }
    );
    if (!res.ok) {
      throw new LiberisError('getBalance', res.status, await res.text());
    }
    return res.json();
  }
}

// =============================================================================
// PARTNER-SIDE MOCK FUNCTIONS
// =============================================================================
// All functions below are STUBS. They simulate your platform's internal APIs.
// Replace each one with real calls to your system.
// Each stub documents:
//   - What your platform API should return
//   - The data shape expected by the Liberis integration above
//   - Any business rules or constraints to be aware of
// =============================================================================

/**
 * MOCK — Replace with your platform's merchant data API.
 *
 * Called by: registerMerchantWithLiberis(), getMerchantOffers()
 *
 * Your API should return the merchant's:
 *   - partnerId       : your internal merchant ID (used as partner_client_id)
 *   - entityType      : map to Liberis taxonomy below:
 *                         SoleTrader | LimitedCompany | LLC | LLP |
 *                         Partnership | SoleProprietor
 *   - clientStartDate : ISO date when merchant joined your platform
 *   - legalName       : registered legal name of the business
 *   - address         : registered business address
 *
 * Example replacement:
 *   const res = await fetch(`https://api.yourplatform.com/merchants/${merchantId}`);
 *   const m = await res.json();
 *   return { partnerId: m.id, entityType: mapEntityType(m.type), ... };
 */
export async function getPlatformMerchant(merchantId: string): Promise<{
  partnerId: string;
  entityType: string;
  clientStartDate: string;
  legalName: string;
  address: Address;
  email?: string;
  phone?: string;
  dateOfBirth?: string;
  registrationNumber?: string;
}> {
  // MOCK — remove this block entirely and replace with your real API call
  console.warn(`[MOCK] getPlatformMerchant(${merchantId}) — replace with real platform API`);
  return {
    partnerId: merchantId,
    entityType: 'SoleTrader', // MOCK: map your entity types to Liberis taxonomy
    clientStartDate: '2022-01-01',
    legalName: 'Mock Merchant Ltd',
    address: {
      line1: '1 Mock Street',
      town_city: 'London',
      postcode: 'EC1A 1BB',
      country: 'UK',
    },
    email: 'merchant@example.com',
    phone: '07700900000',
  };
}

/**
 * MOCK — Replace with your platform's revenue / transaction data API.
 *
 * Called by: submitRevenueClaims()
 *
 * Rules:
 *   - Return last 12 COMPLETE months only (exclude current partial month)
 *   - Use NEGATIVE amount + count for returns and chargebacks
 *   - Date format: 'YYYY-MM'
 *   - Amount is the aggregate for the entire month
 *
 * Example replacement:
 *   const res = await fetch(`https://api.yourplatform.com/merchants/${merchantId}/revenue?months=12`);
 *   return await res.json(); // must match MonthlyVolume[] shape
 */
export async function getPlatformRevenue(
  merchantId: string,
  currency: string
): Promise<MonthlyVolume[]> {
  // MOCK — remove this block and replace with your real revenue query
  console.warn(`[MOCK] getPlatformRevenue(${merchantId}) — replace with real revenue API`);
  const volumes: MonthlyVolume[] = [];
  const now = new Date();
  for (let i = 1; i <= 12; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    volumes.push({
      date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      amount: parseFloat((8000 + Math.random() * 12000).toFixed(2)),
      count: 400 + Math.floor(Math.random() * 600),
      currency,
    });
  }
  return volumes;
}

/**
 * MOCK — Replace with your platform's eligibility check logic.
 *
 * Called by: registerMerchantWithLiberis(), getMerchantOffers()
 *
 * This is YOUR platform-level gate — applied BEFORE calling Liberis.
 * Liberis runs its own underwriting on top. You can restrict further
 * but cannot override Liberis decisions.
 *
 * Suggested rules to implement:
 *   - Minimum months on platform (e.g. >= 3)
 *   - Minimum monthly revenue (e.g. >= £2,000/month average)
 *   - Not on blocklist
 *   - Whitelist bypass (if applicable)
 *
 * Example replacement:
 *   const m = await db.merchants.findById(merchantId);
 *   const monthsOnPlatform = differenceInMonths(new Date(), m.joinedAt);
 *   if (monthsOnPlatform < 3) return { eligible: false, reason: 'Too new' };
 *   return { eligible: true };
 */
export async function checkPlatformEligibility(merchantId: string): Promise<{
  eligible: boolean;
  reason?: string;
}> {
  // MOCK — always eligible; replace with real eligibility logic
  console.warn(`[MOCK] checkPlatformEligibility(${merchantId}) — replace with real check`);
  return { eligible: true };
}

/**
 * MOCK — Replace with a database write to persist the Liberis merchant ID.
 *
 * Called by: getMerchantOffers() after first successful offer retrieval
 *
 * The liberis_id returned by POST /create/v2/offers MUST be stored.
 * It is required for renewal flows — passing it in subsequent /offers
 * calls skips merchant re-registration.
 *
 * Example replacement:
 *   await db.merchants.update({ id: merchantId }, { liberisId: liberisId });
 */
export async function storeLiberisId(merchantId: string, liberisId: string): Promise<void> {
  // MOCK — replace with DB write
  console.warn(`[MOCK] storeLiberisId: ${merchantId} → ${liberisId}`);
}

/**
 * MOCK — Replace with a database read to retrieve a stored Liberis merchant ID.
 *
 * Called by: getMerchantOffers() to detect renewal eligibility
 *
 * Returns null if merchant has never had a Liberis deal (new application).
 * Returns the stored liberis_id if they have a prior or active deal (renewal).
 *
 * Example replacement:
 *   const m = await db.merchants.findById(merchantId);
 *   return m?.liberisId ?? null;
 */
export async function getLiberisId(merchantId: string): Promise<string | null> {
  // MOCK — replace with DB read
  console.warn(`[MOCK] getLiberisId(${merchantId}) — replace with real DB read`);
  return null;
}

/**
 * MOCK — Replace with your real webhook handler.
 *
 * Called by: your HTTP server when Liberis posts to your webhook endpoint
 *
 * IMPORTANT: Add HMAC-SHA256 signature verification before processing.
 * Your webhook secret is provided by Liberis during partner onboarding.
 *
 * Webhook events to handle:
 *   application.submitted     — application received
 *   application.approved      — auto-approved (bureau_search: true)
 *   application.declined      — auto-declined
 *   application.manual_review — sent to manual underwriting team
 *   deal.activated            — deal live, repayment starting
 *   funds.disbursed           — funds sent to merchant
 *   payment.received          — repayment batch registered
 *   deal.completed            — fully repaid
 *   renewal.eligible          — merchant eligible for top-up
 *
 * For "action" webhooks (Liberis requests a partner action), respond
 * using: POST /reference/respond-to-action using notify.url from the hook.
 *
 * Example replacement:
 *   const isValid = verifyHmacSignature(body, signature, process.env.LIBERIS_WEBHOOK_SECRET);
 *   if (!isValid) throw new Error('Invalid webhook signature');
 *   switch (body.event_type) {
 *     case 'deal.activated': await updateMerchantDealStatus(body.merchant_id, 'active'); break;
 *     case 'payment.received': await recordRepayment(body.deal_id, body.amount); break;
 *   }
 */
export async function handleLiberisWebhook(
  body: Record<string, unknown>,
  signature: string
): Promise<void> {
  // MOCK — add HMAC verification and route to real handlers
  console.warn('[MOCK] handleLiberisWebhook — add signature verification');
  const eventType = body.event_type as string;
  console.log(`Received Liberis webhook: ${eventType}`, JSON.stringify(body, null, 2));
}

// =============================================================================
// HIGH-LEVEL ORCHESTRATION FLOWS
// These compose the low-level LiberisClient methods and MOCK platform calls
// into the complete business workflows described in the README.
// =============================================================================

/**
 * FLOW 1: Register a merchant with Liberis.
 *
 * Sequence:
 *   checkPlatformEligibility (MOCK)
 *   → getPlatformMerchant (MOCK)
 *   → POST /data/v1/clients
 *   → poll GET /data/v1/clients/status/{id}
 *
 * Call this:
 *   - When a merchant first expresses interest in financing
 *   - Or proactively for all eligible merchants (batch registration)
 */
export async function registerMerchantWithLiberis(
  client: LiberisClient,
  merchantId: string
): Promise<{ success: boolean; errors?: string[] }> {
  const eligibility = await checkPlatformEligibility(merchantId);
  if (!eligibility.eligible) {
    return { success: false, errors: [eligibility.reason ?? 'Platform eligibility check failed'] };
  }

  const merchant = await getPlatformMerchant(merchantId);

  const { status_check_id } = await client.createPartnerClients([{
    partner_client_id: merchant.partnerId,
    client_start_date: merchant.clientStartDate,
    entity_type: merchant.entityType,
    other_identifiers: [{ key: 'PlatformMerchantId', values: [merchantId] }],
  }]);

  const statusResult = await client.pollClientStatus(status_check_id);
  const item = statusResult.result[0];

  if (item.status.state === 'Completed') return { success: true };
  // Duplicate = merchant already registered = treat as success
  if (item.status.state === 'Duplicate') return { success: true };

  return { success: false, errors: item.status.validation_errors };
}

/**
 * FLOW 2: Submit revenue claims for a merchant (run daily).
 *
 * Sequence:
 *   getPlatformRevenue (MOCK)
 *   → POST /data/v1/revenueClaims
 *
 * Call this:
 *   - Daily via a scheduled job (cron/queue)
 *   - For all active merchants, not just those who have applied
 */
export async function submitRevenueClaims(
  client: LiberisClient,
  merchantId: string
): Promise<{ status_check_id: string }> {
  const volumes = await getPlatformRevenue(merchantId, 'GBP');

  const claims: RevenueClaimPayload[] = volumes.map((v) => ({
    partner_client_id: merchantId,
    time_period: {
      start_time: `${v.date}-01T00:00:00.000Z`,
      // End = last moment of that month
      end_time: new Date(
        new Date(`${v.date}-01`).getFullYear(),
        new Date(`${v.date}-01`).getMonth() + 1,
        0,
        23, 59, 59, 999
      ).toISOString(),
    },
    total_amount: v.amount,
    currency: v.currency,
    transaction_count: v.count,
    // Deterministic unique_reference — safe to re-submit without duplicates
    unique_reference: `${merchantId}-${v.date}`,
  }));

  return client.createRevenueClaims(claims);
}

/**
 * FLOW 3+4: Check eligibility and get underwritten offers.
 *
 * Sequence:
 *   GET /create/v2/advert/{merchant_id}  (eligibility probe — 404 = ineligible)
 *   getLiberisId (MOCK — checks for renewal)
 *   → POST /create/v2/offers
 *   storeLiberisId (MOCK — persists for future renewals)
 *
 * Call this:
 *   - When merchant clicks the financing CTA
 *   - With amountRequested + productId to reprice an existing offer
 *
 * Returns null if the merchant is not eligible (advert 404).
 */
export async function getMerchantOffers(
  client: LiberisClient,
  merchantId: string,
  applicant: Applicant,
  company: Company,
  amountRequested?: number,
  productId?: string
): Promise<OffersResponse | null> {
  // Probe eligibility via advert endpoint before making full offer call
  const advert = await client.getAdvert(merchantId);
  if (!advert) return null; // 404 = not eligible — do not surface reason to merchant

  // Check for stored liberis_id (renewal flow)
  const liberisId = await getLiberisId(merchantId);

  const payload: OffersRequest = {
    application: {
      merchant_id: merchantId,
      currency: 'GBP',
      apply_offer_presets: true,
      intended_use_of_funds: 'Cash Flow',
      ...(liberisId !== null && { liberis_id: liberisId }),
      ...(amountRequested !== undefined && { amount_requested: amountRequested }),
      ...(productId !== undefined && { product_id: productId }),
    },
    consents: {
      bureau_search: true, // triggers auto-underwriting; UK only for automated decisions
      application_comms: true,
    },
    applicants: [applicant],
    company,
  };

  const offersResponse = await client.getOffers(payload);

  // Persist liberis_id for future renewal flows
  await storeLiberisId(merchantId, offersResponse.liberis_id);

  return offersResponse;
}

/**
 * FLOW 5: Accept a merchant's chosen offer.
 *
 * Sequence:
 *   POST /create/v2/offers/{offer_id}/accept
 *
 * Call this:
 *   - When merchant confirms their selected offer
 *   - Further status updates arrive via webhooks (see handleLiberisWebhook)
 *
 * The response contains:
 *   - application_id : store for reference / webhook matching
 *   - links.contract_link : Click2Sign URL (if iFrame journey)
 *   - links.merchant_link : Liberis portal link (if redirect journey)
 */
export async function acceptMerchantOffer(
  client: LiberisClient,
  offerId: string
): Promise<AcceptOfferResponse> {
  const result = await client.acceptOffer(offerId);
  console.log(`Offer accepted — application_id: ${result.application_id}, liberis_id: ${result.liberis_id}`);
  return result;
}

// =============================================================================
// UTILITIES
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class LiberisError extends Error {
  constructor(
    public readonly operation: string,
    public readonly statusCode: number,
    public readonly body: string
  ) {
    super(`Liberis API error [${operation}] HTTP ${statusCode}: ${body}`);
    this.name = 'LiberisError';
  }
}
