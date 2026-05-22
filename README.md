# Liberis Integration Configurator

A self-contained tool for partner teams integrating with the Liberis Capital Platform v3.

---

## What's in this package

| File | Purpose |
|---|---|
| `index.html` | Interactive configurator app (deploy to Vercel / Netlify / S3) |
| `liberis_integration.ts` | TypeScript integration client + orchestration flows |
| `liberis_integration.test.ts` | Jest test suite (6 suites, 27 tests) |
| `liberis_integration.py` | Python async integration client + orchestration flows |
| `test_liberis_integration.py` | pytest test suite (6 suites, 27 tests) |

---

## Deploying the configurator

The `index.html` is a fully self-contained single-file app. No build step needed.

**Vercel**
```bash
# In the directory containing index.html
npx vercel
```

**Netlify**
Drag and drop the folder at app.netlify.com/drop.

**Any static host**
Upload `index.html` — it has zero external dependencies except Google Fonts.

---

## Using the TypeScript integration

### Installation
```bash
npm install
npm install -D jest ts-jest @types/jest @types/node typescript
```

Minimum `tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true
  }
}
```

### Quick-start: business cases → functions

| Business case | Function to call |
|---|---|
| Onboard a merchant | `registerMerchantWithLiberis(client, merchantId)` |
| Submit revenue data (daily) | `submitRevenueClaims(client, merchantId)` |
| Check eligibility (dashboard load) | `client.getAdvert(merchantId)` |
| Get underwritten offers | `getMerchantOffers(client, merchantId, applicant, company)` |
| Reprice an offer | `getMerchantOffers(..., amountRequested, productId)` |
| Accept an offer | `acceptMerchantOffer(client, offerId)` |
| View outstanding balance | `client.getBalance(merchantId)` |
| Handle inbound webhooks | `handleLiberisWebhook(body, signature)` |

### Usage
```typescript
import { LiberisClient, LiberisConfig, registerMerchantWithLiberis, getMerchantOffers } from './liberis_integration';

const config: LiberisConfig = {
  clientId: process.env.LIBERIS_CLIENT_ID!,
  clientSecret: process.env.LIBERIS_CLIENT_SECRET!,
  baseUrl: 'https://platform.eu.liberis.com', // UK/EU
  env: 'sandbox',
};

const client = new LiberisClient(config);

// 1. Register a merchant
const reg = await registerMerchantWithLiberis(client, 'MERCH_001');

// 2. Get offers when merchant clicks CTA
const offers = await getMerchantOffers(client, 'MERCH_001', applicant, company);
```

### Running tests
```bash
npx jest liberis_integration.test.ts --verbose
```

---

## Using the Python integration

### Installation
```bash
pip install httpx python-dotenv
pip install pytest pytest-asyncio  # for tests
```

Add to `pytest.ini` or `pyproject.toml`:
```ini
[pytest]
asyncio_mode = auto
```

### Quick-start: business cases → functions

| Business case | Function to call |
|---|---|
| Onboard a merchant | `await register_merchant_with_liberis(client, merchant_id)` |
| Submit revenue data (daily) | `await submit_revenue_claims(client, merchant_id)` |
| Check eligibility (dashboard load) | `await client.get_advert(merchant_id)` |
| Get underwritten offers | `await get_merchant_offers(client, merchant_id, applicant, company)` |
| Reprice an offer | `await get_merchant_offers(..., amount_requested, product_id)` |
| Accept an offer | `await accept_merchant_offer(client, offer_id)` |
| View outstanding balance | `await client.get_balance(merchant_id)` |
| Handle inbound webhooks | `await handle_liberis_webhook(body, signature)` |

### Usage
```python
import asyncio
from liberis_integration import LiberisClient, LiberisConfig, register_merchant_with_liberis

config = LiberisConfig(
    client_id="your-client-id",
    client_secret="your-client-secret",
    base_url="https://platform.eu.liberis.com",
    env="sandbox",
)

async def main():
    async with LiberisClient(config) as client:
        result = await register_merchant_with_liberis(client, "MERCH_001")
        print(result)

asyncio.run(main())
```

### Running tests
```bash
pytest test_liberis_integration.py -v
```

---

## Replacing the MOCK functions

Both integration files contain platform-side stub functions clearly marked `# MOCK` (Python) or `// MOCK` (TypeScript). Replace each one with a real call to your platform's API.

| Mock function | What it should do |
|---|---|
| `getPlatformMerchant` | Fetch merchant profile from your DB/API |
| `getPlatformRevenue` | Fetch 12mo transaction aggregates |
| `checkPlatformEligibility` | Apply your platform-level eligibility rules |
| `storeLiberisId` | Persist `liberis_id` to your DB (required for renewals) |
| `getLiberisId` | Read stored `liberis_id` from your DB |
| `handleLiberisWebhook` | Verify HMAC signature + route webhook events |

If you uploaded your OpenAPI schema in the configurator, review Step 2 of the generated HTML — your detected endpoints are listed there to help map them to the stubs above.

---

## Liberis API endpoints used

All endpoints are from the official v3 documentation at https://docs.liberis.com/v3/reference

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/auth/v1/token` | OAuth2 client_credentials → Bearer token |
| POST | `/data/v1/clients` | Register merchant (async) |
| GET | `/data/v1/clients/status/{id}` | Poll registration status |
| POST | `/data/v1/revenueClaims` | Submit revenue claims (async) |
| GET | `/data/v1/revenueClaims/status/{id}` | Poll revenue status |
| GET | `/create/v2/advert/{reference}` | Check eligibility + fetch advert copy |
| POST | `/create/v2/offers` | Get underwritten offers / reprice |
| POST | `/create/v2/offers/{offer_id}/accept` | Accept selected offer |
| GET | `/create/v2/balance/{merchant_id}` | Outstanding balance + split % |

---

## Next steps (sandbox phase)

Once you have Liberis sandbox credentials from your partner manager:

1. Set `env: 'sandbox'` and use `baseUrl: 'https://platform.eu.liberis.com'` (or US equivalent)
2. Replace all `// MOCK` / `# MOCK` functions with real platform calls
3. Run the test suite against sandbox — assertions will validate real response shapes
4. The configurator will be extended to generate a Postman collection and boilerplate code from your actual sandbox responses

Contact your Liberis partner manager to request sandbox credentials:
https://docs.liberis.com/v3/docs/sandbox
