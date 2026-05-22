"""
=============================================================================
liberis_integration.py
=============================================================================
Liberis Capital Platform v3 — Partner Integration Client (Python)

API Reference : https://docs.liberis.com/v3/reference
Endpoints used: All from official Liberis v3 OpenAPI documentation
Test framework : pytest + pytest-asyncio (see test_liberis_integration.py)
Runtime        : Python 3.10+

-----------------------------------------------------------------------------
QUICK-START: WHICH FUNCTION TO CALL FOR EACH BUSINESS CASE
-----------------------------------------------------------------------------

 1. AUTHENTICATE
    LiberisClient.get_token()
    → Called automatically by all methods. You do not need to call
      this directly. Token is cached for 23h (expires_in = 86400s).

 2. ONBOARD A MERCHANT (register with Liberis)
    await register_merchant_with_liberis(client, merchant_id)
    → Checks platform eligibility, calls POST /data/v1/clients,
      polls GET /data/v1/clients/status/{id} until Completed.

 3. SUBMIT REVENUE DATA (run daily)
    await submit_revenue_claims(client, merchant_id)
    → Fetches 12 months of revenue from your platform (MOCK),
      calls POST /data/v1/revenueClaims.

 4. CHECK IF MERCHANT IS ELIGIBLE FOR FINANCING (dashboard load)
    await client.get_advert(merchant_id)
    → Calls GET /create/v2/advert/{reference}.
      Returns advert dict if eligible, None if not (404).
      Use None to hide the financing banner — do NOT expose
      ineligibility to the merchant.

 5. GET UNDERWRITTEN OFFERS (merchant clicks CTA)
    await get_merchant_offers(client, merchant_id, applicant, company)
    → Calls POST /create/v2/offers with bureau_search=True.
      Automatically passes liberis_id for renewals if stored.
      Returns dict with products, offers, factor rates, funded amounts.

 6. REPRICE AN OFFER (merchant adjusts amount slider)
    await get_merchant_offers(
        client, merchant_id, applicant, company,
        amount_requested=15000, product_id="prod-bca-xxx"
    )
    → Re-calls POST /create/v2/offers with amount_requested + product_id.

 7. ACCEPT AN OFFER (merchant confirms)
    await accept_merchant_offer(client, offer_id)
    → Calls POST /create/v2/offers/{offer_id}/accept.
      Subsequent updates arrive via webhooks.

 8. VIEW BALANCE / OUTSTANDING AMOUNT (merchant dashboard)
    await client.get_balance(merchant_id)
    → Calls GET /create/v2/balance/{merchant_id}.
      Returns outstanding balance and active split percentage.

 9. HANDLE INBOUND WEBHOOKS (deal events)
    await handle_liberis_webhook(body, signature)
    → Route deal.activated / payment.received / deal.completed etc.
      Add HMAC-SHA256 signature verification — see MOCK below.

-----------------------------------------------------------------------------
MOCK FUNCTIONS — MUST BE REPLACED
-----------------------------------------------------------------------------
All functions marked # MOCK are stubs that simulate your platform's
internal API calls. Replace each one with a real call to your system.
Each stub documents the expected contract (inputs/outputs).

-----------------------------------------------------------------------------
INSTALLATION
-----------------------------------------------------------------------------
  pip install httpx python-dotenv

  For tests:
  pip install pytest pytest-asyncio

  pytest.ini (or pyproject.toml):
  [pytest]
  asyncio_mode = auto
=============================================================================
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional

import httpx

logger = logging.getLogger(__name__)


# =============================================================================
# CONFIGURATION
# =============================================================================

@dataclass
class LiberisConfig:
    client_id: str
    client_secret: str
    base_url: str
    """
    Base URL determined by region:
      UK / EU -> https://platform.eu.liberis.com
      US      -> https://platform.us.liberis.com
    """
    env: str = "sandbox"  # "sandbox" | "production"


# =============================================================================
# EXCEPTIONS
# =============================================================================

class LiberisError(Exception):
    """Raised when the Liberis API returns a non-2xx response."""

    def __init__(self, operation: str, status_code: int, body: str) -> None:
        self.operation = operation
        self.status_code = status_code
        self.body = body
        super().__init__(f"Liberis API error [{operation}] HTTP {status_code}: {body}")


# =============================================================================
# TOKEN CACHE — module-level singleton
# =============================================================================

_token_cache: dict[str, Any] = {}
# Shape: { "access_token": str, "expires_at": float (unix timestamp) }


# =============================================================================
# LIBERIS API CLIENT
# All methods map 1-to-1 to documented v3 API endpoints.
# =============================================================================

class LiberisClient:
    """
    Async HTTP client for the Liberis Capital Platform API.

    Usage:
        config = LiberisConfig(client_id="...", client_secret="...", base_url="...")
        async with LiberisClient(config) as client:
            offers = await get_merchant_offers(client, merchant_id, applicant, company)
    """

    def __init__(self, config: LiberisConfig) -> None:
        self.config = config
        self._http = httpx.AsyncClient(timeout=30.0)

    async def __aenter__(self) -> "LiberisClient":
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self._http.aclose()

    async def close(self) -> None:
        await self._http.aclose()

    # -------------------------------------------------------------------------
    # AUTH — POST /auth/v1/token
    # Ref: https://docs.liberis.com/reference/retrieve-token
    # -------------------------------------------------------------------------
    async def get_token(self) -> str:
        """
        Obtain a Bearer token via client_credentials grant.
        Token is cached at module level for 23h (expires_in = 86400s).
        """
        global _token_cache
        now = time.time()
        if _token_cache.get("expires_at", 0) > now:
            return _token_cache["access_token"]

        res = await self._http.post(
            f"{self.config.base_url}/auth/v1/token",
            json={
                "client_id": self.config.client_id,
                "client_secret": self.config.client_secret,
                "grant_type": "client_credentials",
            },
        )
        if not res.is_success:
            raise LiberisError("get_token", res.status_code, res.text)

        data = res.json()
        _token_cache = {
            "access_token": data["access_token"],
            # Proactive refresh 1h before actual expiry
            "expires_at": now + data["expires_in"] - 3600,
        }
        return data["access_token"]

    async def _auth_headers(self) -> dict[str, str]:
        return {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {await self.get_token()}",
        }

    # -------------------------------------------------------------------------
    # REGISTER MERCHANT — POST /data/v1/clients
    # Async: returns status_check_id for polling.
    # Idempotency-Key (UUID v4) is REQUIRED.
    # Ref: https://docs.liberis.com/reference/create-partner-client
    # -------------------------------------------------------------------------
    async def create_partner_clients(self, clients: list[dict]) -> dict:
        """
        Register one or more merchants with Liberis.

        Args:
            clients: List of dicts. Each requires:
                partner_client_id : your internal merchant ID
                client_start_date : ISO date (YYYY-MM-DD) when merchant joined platform
                entity_type       : Liberis taxonomy (SoleTrader | LimitedCompany | ...)
                other_identifiers : optional list of {key, values[]}

        Returns:
            {"status_check_id": str, "status_check_uri": str}
        """
        headers = await self._auth_headers()
        headers["Idempotency-Key"] = str(uuid.uuid4())
        res = await self._http.post(
            f"{self.config.base_url}/data/v1/clients",
            json=clients,
            headers=headers,
        )
        if not res.is_success:
            raise LiberisError("create_partner_clients", res.status_code, res.text)
        return res.json()

    # -------------------------------------------------------------------------
    # POLL CLIENT STATUS — GET /data/v1/clients/status/{status_check_id}
    # Polls until top-level status = "Completed".
    # Per-item states: Pending | Completed | Duplicate | Conflict | Failed
    # Ref: https://docs.liberis.com/reference/get-partner-client-status
    # -------------------------------------------------------------------------
    async def poll_client_status(
        self,
        status_check_id: str,
        max_attempts: int = 10,
        delay_s: float = 3.0,
    ) -> dict:
        """
        Poll until all clients in the batch have been processed.

        Check result[i].status.state per item:
          Completed  -> saved successfully
          Duplicate  -> already exists (treat as success)
          Conflict   -> duplicate partner_client_id with differing data
          Failed     -> validation error; see result[i].status.validation_errors
        """
        for attempt in range(max_attempts):
            res = await self._http.get(
                f"{self.config.base_url}/data/v1/clients/status/{status_check_id}",
                headers=await self._auth_headers(),
            )
            if not res.is_success:
                raise LiberisError("poll_client_status", res.status_code, res.text)
            data = res.json()
            if data["status"] == "Completed":
                return data
            await asyncio.sleep(delay_s)
        raise TimeoutError(
            f"poll_client_status: timed out after {max_attempts} attempts "
            f"for status_check_id={status_check_id}"
        )

    # -------------------------------------------------------------------------
    # SUBMIT REVENUE CLAIMS — POST /data/v1/revenueClaims
    # - unique_reference must be DETERMINISTIC (re-creatable your side)
    # - Negative total_amount + transaction_count for returns/chargebacks
    # - Do NOT include the current partial month
    # - Daily and Monthly granularity both supported
    # Ref: https://docs.liberis.com/reference/create-partner-client-revenue
    # -------------------------------------------------------------------------
    async def create_revenue_claims(self, claims: list[dict]) -> dict:
        """
        Submit revenue claims for one or more merchants.

        Each claim dict requires:
            partner_client_id : str
            time_period       : {"start_time": ISO8601, "end_time": ISO8601}
            total_amount      : float  (negative for returns)
            currency          : str    (e.g. "GBP")
            transaction_count : int    (negative for returns)
            unique_reference  : str    (deterministic; e.g. f"{merchant_id}-{YYYY-MM}")

        Returns:
            {"status_check_id": str, "status_check_uri": str}
        """
        headers = await self._auth_headers()
        headers["Idempotency-Key"] = str(uuid.uuid4())
        res = await self._http.post(
            f"{self.config.base_url}/data/v1/revenueClaims",
            json=claims,
            headers=headers,
        )
        if not res.is_success:
            raise LiberisError("create_revenue_claims", res.status_code, res.text)
        return res.json()

    # -------------------------------------------------------------------------
    # GET ADVERT — GET /create/v2/advert/{reference}
    # Returns advert copy if merchant is eligible.
    # Returns None (404) if merchant is not eligible.
    # Ref: https://docs.liberis.com/reference/get-advert
    # -------------------------------------------------------------------------
    async def get_advert(
        self,
        merchant_id: str,
        locale: str | None = None,
    ) -> dict | None:
        """
        Check eligibility and fetch dashboard advert copy.

        Returns None if merchant is not eligible (404 response).
        Do NOT expose ineligibility to the merchant directly.
        Use the None return value to show/hide the financing banner.

        Supports optional locale query param for localised copy.
        """
        params = {"locale": locale} if locale else {}
        res = await self._http.get(
            f"{self.config.base_url}/create/v2/advert/{merchant_id}",
            headers=await self._auth_headers(),
            params=params,
        )
        if res.status_code == 404:
            return None  # not eligible
        if not res.is_success:
            raise LiberisError("get_advert", res.status_code, res.text)
        return res.json()

    # -------------------------------------------------------------------------
    # GET OFFERS — POST /create/v2/offers
    # bureau_search=True → auto-underwriting (automated decisions: UK only)
    # bureau_search=False → indicative offer; manual underwriting required
    # Ref: https://docs.liberis.com/reference/get-offers
    # -------------------------------------------------------------------------
    async def get_offers(self, payload: dict) -> dict:
        """
        Submit a full application and retrieve underwritten offers.

        Key payload fields:
            application.merchant_id         : required
            application.currency            : "GBP" | "USD"
            application.liberis_id          : pass for renewals
            application.amount_requested    : pass for custom repricing
            application.product_id          : required with amount_requested
            application.apply_offer_presets : True = 3 presets, False = full range
            consents.bureau_search          : True triggers auto-decisioning
            applicants[]                    : list with primary applicant
            company                         : business details + revenue data
        """
        res = await self._http.post(
            f"{self.config.base_url}/create/v2/offers",
            json=payload,
            headers=await self._auth_headers(),
        )
        if not res.is_success:
            raise LiberisError("get_offers", res.status_code, res.text)
        return res.json()

    # -------------------------------------------------------------------------
    # ACCEPT OFFER — POST /create/v2/offers/{offer_id}/accept
    # Locks the offer and begins fulfilment pipeline.
    # 409 Conflict = offer already accepted (idempotent by offer_id).
    # Ref: https://docs.liberis.com/reference/accept-an-offer
    # -------------------------------------------------------------------------
    async def accept_offer(
        self,
        offer_id: str,
        bank_details: dict | None = None,
    ) -> dict:
        """
        Accept a selected offer and begin fulfilment.

        Optional bank_details dict:
            bank_name      : str
            account_number : str
            account_type   : "NONE" | "IBAN" | "LOCAL_SE" | "PLUSGIRO" | "BANKGIRO"
            sort_code      : str (UK)
            routing_number : str (US)

        Raises LiberisError with status_code=409 if offer already accepted.
        """
        body = {"bank_details": bank_details} if bank_details else {}
        res = await self._http.post(
            f"{self.config.base_url}/create/v2/offers/{offer_id}/accept",
            json=body,
            headers=await self._auth_headers(),
        )
        if not res.is_success:
            raise LiberisError("accept_offer", res.status_code, res.text)
        return res.json()

    # -------------------------------------------------------------------------
    # GET BALANCE — GET /create/v2/balance/{merchant_id}
    # Returns outstanding balance + split % for an active deal.
    # -------------------------------------------------------------------------
    async def get_balance(self, merchant_id: str) -> dict:
        """
        Get current outstanding balance and repayment split % for active deal.
        Call on merchant dashboard load to surface repayment progress.
        """
        res = await self._http.get(
            f"{self.config.base_url}/create/v2/balance/{merchant_id}",
            headers=await self._auth_headers(),
        )
        if not res.is_success:
            raise LiberisError("get_balance", res.status_code, res.text)
        return res.json()


# =============================================================================
# PARTNER-SIDE MOCK FUNCTIONS
# =============================================================================
# All functions below are STUBS. Replace each one with a real call to your
# platform's API or database. The contract (inputs/outputs) is documented
# in each function's docstring.
# =============================================================================


async def get_platform_merchant(merchant_id: str) -> dict:
    """
    # MOCK — Replace with your platform's merchant data API.
    #
    # Called by: register_merchant_with_liberis(), get_merchant_offers()
    #
    # Expected return shape:
    #   partner_id        : str  — your internal merchant ID
    #   entity_type       : str  — mapped to Liberis taxonomy:
    #                               SoleTrader | LimitedCompany | LLC | LLP |
    #                               Partnership | SoleProprietor
    #   client_start_date : str  — ISO date when merchant joined your platform
    #   legal_name        : str  — registered business name
    #   address           : dict — {line1, town_city, postcode, country}
    #   email             : str  (optional)
    #   phone             : str  (optional)
    #   date_of_birth     : str  (optional, YYYY-MM-DD)
    #   registration_number: str (required for Limited Company / LLP)
    #
    # Example replacement:
    #   async with httpx.AsyncClient() as http:
    #       res = await http.get(f"https://api.yourplatform.com/merchants/{merchant_id}")
    #       m = res.json()
    #       return {"partner_id": m["id"], "entity_type": _map_entity_type(m["type"]), ...}
    """
    logger.warning("[MOCK] get_platform_merchant(%s) — replace with real platform API", merchant_id)
    return {
        "partner_id": merchant_id,
        "entity_type": "SoleTrader",  # MOCK: map your entity types to Liberis taxonomy
        "client_start_date": "2022-01-01",
        "legal_name": "Mock Merchant Ltd",
        "address": {
            "line1": "1 Mock Street",
            "town_city": "London",
            "postcode": "EC1A 1BB",
            "country": "UK",
        },
        "email": "merchant@example.com",
        "phone": "07700900000",
    }


async def get_platform_revenue(merchant_id: str, currency: str) -> list[dict]:
    """
    # MOCK — Replace with your platform's revenue / transaction data API.
    #
    # Called by: submit_revenue_claims()
    #
    # Rules:
    #   - Return last 12 COMPLETE months only (exclude current partial month)
    #   - Use NEGATIVE amount + count for returns and chargebacks
    #   - date format: "YYYY-MM"
    #   - amount is the full-month aggregate
    #
    # Expected return shape (list of dicts):
    #   date     : str   — "YYYY-MM"
    #   amount   : float — monthly aggregate (negative for returns)
    #   count    : int   — transaction count (negative for returns)
    #   currency : str   — e.g. "GBP"
    #
    # Example replacement:
    #   res = await http.get(
    #       f"https://api.yourplatform.com/merchants/{merchant_id}/revenue",
    #       params={"months": 12}
    #   )
    #   return res.json()  # must match shape above
    """
    import random
    logger.warning("[MOCK] get_platform_revenue(%s) — replace with real revenue API", merchant_id)
    volumes = []
    today = date.today()
    for i in range(1, 13):
        # Walk back i months from current month
        month = today.month - i
        year = today.year + (month - 1) // 12
        month = ((month - 1) % 12) + 1
        volumes.append({
            "date": f"{year}-{month:02d}",
            "amount": round(8000 + random.random() * 12000, 2),
            "count": 400 + random.randint(0, 600),
            "currency": currency,
        })
    return volumes


async def check_platform_eligibility(merchant_id: str) -> dict:
    """
    # MOCK — Replace with your platform's eligibility check logic.
    #
    # Called by: register_merchant_with_liberis(), get_merchant_offers()
    #
    # This is YOUR platform-level gate — applied BEFORE calling Liberis.
    # Liberis runs its own underwriting on top. You can restrict further
    # but cannot override Liberis decisions.
    #
    # Suggested rules to implement:
    #   - Minimum months on platform (e.g. >= 3)
    #   - Minimum average monthly revenue (e.g. >= £2,000)
    #   - Not on your internal blocklist
    #   - Whitelist bypass (if applicable)
    #
    # Expected return shape:
    #   eligible : bool
    #   reason   : str  (optional — only when eligible=False)
    #
    # Example replacement:
    #   merchant = await db.merchants.get(merchant_id)
    #   months = (date.today() - merchant.joined_at.date()).days // 30
    #   if months < 3:
    #       return {"eligible": False, "reason": "Too new — less than 3 months"}
    #   return {"eligible": True}
    """
    logger.warning("[MOCK] check_platform_eligibility(%s) — replace with real check", merchant_id)
    return {"eligible": True}  # MOCK: always eligible


async def store_liberis_id(merchant_id: str, liberis_id: str) -> None:
    """
    # MOCK — Replace with a database write.
    #
    # Called by: get_merchant_offers() after first successful offer retrieval.
    #
    # The liberis_id returned by POST /create/v2/offers MUST be persisted.
    # It is required for renewal flows — passing it in subsequent /offers
    # calls skips re-registration and creates a top-up application.
    #
    # Example replacement:
    #   await db.execute(
    #       "UPDATE merchants SET liberis_id = $1 WHERE id = $2",
    #       liberis_id, merchant_id
    #   )
    """
    logger.warning("[MOCK] store_liberis_id: %s -> %s", merchant_id, liberis_id)


async def get_liberis_id(merchant_id: str) -> str | None:
    """
    # MOCK — Replace with a database read.
    #
    # Called by: get_merchant_offers() to detect renewal eligibility.
    #
    # Returns None   → new application (first-time merchant)
    # Returns str    → renewal/top-up flow (prior or active deal exists)
    #
    # Example replacement:
    #   row = await db.fetchrow("SELECT liberis_id FROM merchants WHERE id = $1", merchant_id)
    #   return row["liberis_id"] if row else None
    """
    logger.warning("[MOCK] get_liberis_id(%s) — replace with real DB read", merchant_id)
    return None


async def handle_liberis_webhook(body: dict, signature: str) -> None:
    """
    # MOCK — Replace with your real webhook handler.
    #
    # Called by: your HTTP server when Liberis POSTs to your webhook endpoint.
    #
    # IMPORTANT: Add HMAC-SHA256 signature verification before processing.
    # Your webhook secret is provided by Liberis during partner onboarding.
    #
    # Webhook event types to handle:
    #   application.submitted       application received
    #   application.approved        auto-approved (bureau_search=True)
    #   application.declined        auto-declined
    #   application.manual_review   sent to Liberis manual team
    #   deal.activated              deal live, repayment starting
    #   funds.disbursed             funds sent to merchant bank
    #   payment.received            repayment batch registered
    #   deal.completed              fully repaid
    #   renewal.eligible            merchant eligible for top-up
    #
    # For "action" webhooks (Liberis requests a partner action), respond via:
    #   POST notify.url (from the webhook body) using /reference/respond-to-action
    #
    # Example replacement:
    #   import hmac, hashlib
    #   expected = hmac.new(WEBHOOK_SECRET.encode(), raw_body, hashlib.sha256).hexdigest()
    #   if not hmac.compare_digest(expected, signature):
    #       raise ValueError("Invalid webhook signature")
    #   event_type = body.get("event_type")
    #   if event_type == "deal.activated":
    #       await update_merchant_deal_status(body["merchant_id"], "active")
    #   elif event_type == "payment.received":
    #       await record_repayment(body["deal_id"], body["amount"])
    """
    logger.warning("[MOCK] handle_liberis_webhook — add HMAC signature verification")
    event_type = body.get("event_type")
    logger.info("Received Liberis webhook: %s — %s", event_type, json.dumps(body))


# =============================================================================
# HIGH-LEVEL ORCHESTRATION FLOWS
# These compose the low-level LiberisClient methods and MOCK platform calls
# into the complete business workflows described at the top of this file.
# =============================================================================


async def register_merchant_with_liberis(
    client: LiberisClient,
    merchant_id: str,
) -> dict:
    """
    FLOW 1: Register a merchant with Liberis.

    Sequence:
        check_platform_eligibility (MOCK)
        -> get_platform_merchant (MOCK)
        -> POST /data/v1/clients
        -> poll GET /data/v1/clients/status/{id}

    Returns:
        {"success": True}
        {"success": False, "errors": ["..."]}

    Call this:
        - When a merchant first expresses interest in financing, or
        - Proactively for all eligible merchants in a daily batch
    """
    eligibility = await check_platform_eligibility(merchant_id)
    if not eligibility.get("eligible"):
        return {
            "success": False,
            "errors": [eligibility.get("reason", "Platform eligibility check failed")],
        }

    merchant = await get_platform_merchant(merchant_id)

    resp = await client.create_partner_clients([{
        "partner_client_id": merchant["partner_id"],
        "client_start_date": merchant["client_start_date"],
        "entity_type": merchant["entity_type"],
        "other_identifiers": [{"key": "PlatformMerchantId", "values": [merchant_id]}],
    }])

    status = await client.poll_client_status(resp["status_check_id"])
    item = status["result"][0]
    state = item["status"]["state"]

    if state == "Completed":
        return {"success": True}
    if state == "Duplicate":
        # Duplicate = already registered = treat as success
        return {"success": True}

    return {
        "success": False,
        "errors": item["status"].get("validation_errors", [f"Unexpected state: {state}"]),
    }


async def submit_revenue_claims(
    client: LiberisClient,
    merchant_id: str,
    currency: str = "GBP",
) -> dict:
    """
    FLOW 2: Submit revenue claims for a merchant (run daily).

    Sequence:
        get_platform_revenue (MOCK)
        -> POST /data/v1/revenueClaims

    Returns:
        {"status_check_id": str, "status_check_uri": str}

    Call this:
        - Daily via a scheduled job (cron/Celery/Airflow)
        - For all active merchants, not just those who have applied
    """
    volumes = await get_platform_revenue(merchant_id, currency)
    claims = []

    for v in volumes:
        # Parse YYYY-MM to build ISO 8601 period boundaries
        year, month = map(int, v["date"].split("-"))
        start = datetime(year, month, 1, tzinfo=timezone.utc)
        # Last moment of the month
        if month == 12:
            end = datetime(year + 1, 1, 1, tzinfo=timezone.utc) - timedelta(milliseconds=1)
        else:
            end = datetime(year, month + 1, 1, tzinfo=timezone.utc) - timedelta(milliseconds=1)

        claims.append({
            "partner_client_id": merchant_id,
            "time_period": {
                "start_time": start.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
                "end_time": end.strftime("%Y-%m-%dT%H:%M:%S.999Z"),
            },
            "total_amount": v["amount"],
            "currency": v["currency"],
            "transaction_count": v["count"],
            # Deterministic unique_reference — safe to re-submit without duplicates
            "unique_reference": f"{merchant_id}-{v['date']}",
        })

    return await client.create_revenue_claims(claims)


async def get_merchant_offers(
    client: LiberisClient,
    merchant_id: str,
    applicant: dict,
    company: dict,
    amount_requested: float | None = None,
    product_id: str | None = None,
) -> dict | None:
    """
    FLOWS 3+4: Check eligibility and get underwritten offers.

    Sequence:
        GET /create/v2/advert/{merchant_id}  (eligibility probe — None = ineligible)
        get_liberis_id (MOCK — checks for renewal)
        -> POST /create/v2/offers
        store_liberis_id (MOCK — persists for future renewals)

    Args:
        client          : LiberisClient instance
        merchant_id     : your internal merchant ID
        applicant       : dict matching Applicant schema (see docs)
        company         : dict matching Company schema (see docs)
        amount_requested: optional float — reprice to a specific amount
        product_id      : required with amount_requested (from prior offers response)

    Returns:
        dict  — OffersResponse with products[], liberis_id, expires_at
        None  — merchant not eligible (advert 404)

    Call this:
        - When merchant clicks the financing CTA (standard flow)
        - With amount_requested + product_id to reprice an existing offer
    """
    # Probe eligibility via advert endpoint before making full offer call
    advert = await client.get_advert(merchant_id)
    if advert is None:
        return None  # 404 = not eligible; do not surface reason to merchant

    # Check for stored liberis_id (renewal flow)
    liberis_id = await get_liberis_id(merchant_id)

    payload: dict = {
        "application": {
            "merchant_id": merchant_id,
            "currency": "GBP",
            "apply_offer_presets": True,
            "intended_use_of_funds": "Cash Flow",
            **({"liberis_id": liberis_id} if liberis_id else {}),
            **({"amount_requested": amount_requested} if amount_requested is not None else {}),
            **({"product_id": product_id} if product_id else {}),
        },
        "consents": {
            "bureau_search": True,   # triggers auto-underwriting; UK only for automated decisions
            "application_comms": True,
        },
        "applicants": [applicant],
        "company": company,
    }

    offers_response = await client.get_offers(payload)

    # Persist liberis_id for future renewal flows
    await store_liberis_id(merchant_id, offers_response["liberis_id"])

    return offers_response


async def accept_merchant_offer(
    client: LiberisClient,
    offer_id: str,
    bank_details: dict | None = None,
) -> dict:
    """
    FLOW 5: Accept a merchant's chosen offer.

    Sequence:
        POST /create/v2/offers/{offer_id}/accept

    Args:
        client       : LiberisClient instance
        offer_id     : offer_id from OffersResponse.products[].offers[].offer_id
        bank_details : optional dict to speed disbursement (see accept_offer docstring)

    Returns:
        dict with application_id, liberis_id, offer echo, and links:
          links.contract_link — Click2Sign URL (iFrame journey)
          links.merchant_link — Liberis portal URL (redirect journey)

    Call this:
        - When merchant confirms their selected offer
        - Further status updates arrive via webhooks (see handle_liberis_webhook)
    """
    result = await client.accept_offer(offer_id, bank_details)
    logger.info(
        "Offer accepted — application_id: %s, liberis_id: %s",
        result["application_id"],
        result["liberis_id"],
    )
    return result
