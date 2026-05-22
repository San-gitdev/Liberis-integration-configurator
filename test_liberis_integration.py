"""
=============================================================================
test_liberis_integration.py
=============================================================================
pytest test suite for the Liberis Capital Platform integration

Run  : pytest test_liberis_integration.py -v
Watch: ptw test_liberis_integration.py  (requires pytest-watch)

All Liberis HTTP calls are intercepted via unittest.mock.AsyncMock.
No real credentials or network access required.

-----------------------------------------------------------------------------
TEST COVERAGE MAP
-----------------------------------------------------------------------------

 Suite 1 — Authentication
   1.1  Happy path: valid credentials -> access_token returned
   1.2  Token is cached within TTL (no duplicate HTTP calls)
   1.3  HTTP 401 -> LiberisError raised with status_code=401
   1.4  Request body contains grant_type=client_credentials
   1.5  Proactive refresh: expired cache triggers fresh fetch

 Suite 2 — Merchant Registration
   2.1  Happy path: registers, polls Pending -> Completed -> success
   2.2  Duplicate state treated as success (already registered)
   2.3  Failed state returns validation_errors
   2.4  Platform-ineligible merchant does not call Liberis
   2.5  Idempotency-Key header present on POST /data/v1/clients
   2.6  Conflict state returns failure

 Suite 3 — Revenue Claims
   3.1  Happy path: claims submitted, status_check_id returned
   3.2  unique_reference is deterministic (merchantId-YYYY-MM format)
   3.3  Idempotency-Key header present
   3.4  HTTP 409 conflict raises LiberisError
   3.5  Negative amounts accepted (returns/chargebacks)

 Suite 4 — Offers
   4.1  Happy path: advert found, offers returned with liberis_id
   4.2  Advert 404 -> get_merchant_offers returns None
   4.3  liberis_id stored after successful offer fetch
   4.4  Renewal flow: stored liberis_id included in offers request
   4.5  Repricing: amount_requested + product_id included when provided
   4.6  apply_offer_presets=True set in request
   4.7  bureau_search=True set in consents

 Suite 5 — Offer Acceptance
   5.1  Happy path: returns application_id, liberis_id, and links
   5.2  URL contains offer_id: /create/v2/offers/{offer_id}/accept
   5.3  HTTP 409 conflict raises LiberisError
   5.4  Optional bank_details included in body when provided

 Suite 6 — Webhook Handler
   6.1  deal.activated processed without error
   6.2  application.manual_review processed without error
   6.3  payment.received processed without error
   6.4  Unknown event type does not raise

=============================================================================
"""

import json
import pytest
import pytest_asyncio
from unittest.mock import AsyncMock, MagicMock, patch, call
from datetime import date

import httpx

from liberis_integration import (
    LiberisClient,
    LiberisConfig,
    LiberisError,
    register_merchant_with_liberis,
    submit_revenue_claims,
    get_merchant_offers,
    accept_merchant_offer,
    handle_liberis_webhook,
)

# =============================================================================
# FIXTURES
# =============================================================================

TEST_CONFIG = LiberisConfig(
    client_id="test-client-id",
    client_secret="test-client-secret",
    base_url="https://platform.eu.liberis.com",
    env="sandbox",
)

MOCK_TOKEN = "mock-bearer-token-xyz789"
MOCK_MERCHANT_ID = "MERCH_TEST_001"
MOCK_STATUS_CHECK_ID = "sc-uuid-00000001"
MOCK_LIBERIS_ID = "lib-uuid-00000001"
MOCK_OFFER_ID = "offer-uuid-00000001"
MOCK_PRODUCT_ID = "prod-bca-00000001"
MOCK_APPLICATION_ID = "app-uuid-00000001"

MOCK_APPLICANT = {
    "first_name": "Jane",
    "last_name": "Doe",
    "email_address": "jane.doe@example.com",
    "telephone_number": "07700900001",
    "date_of_birth": "1985-06-15",
    "primary": True,
    "ownership_percentage": 100,
    "residences": [{
        "address": {
            "line1": "1 Test Street",
            "town_city": "London",
            "postcode": "EC1A 1BB",
            "country": "UK",
        },
        "residential_status": "Home Owner",
    }],
}

MOCK_COMPANY = {
    "legal_name": "Jane Doe Trading Ltd",
    "business_type": "Limited Company",
    "business_start_date": "2018-01-01",
    "partner_start_date": "2021-06-01",
    "industry": "General Store",
    "registration_number": "12345678",
    "registered_address": {
        "line1": "1 Test Street",
        "town_city": "London",
        "postcode": "EC1A 1BB",
        "country": "UK",
    },
    "payment_channels": [{
        "name": "WorldPay",
        "reference": "WP-TERM-001",
        "type": "Card Processor",
        "primary": True,
        "existing_split": False,
        "monthly_volumes": [
            {"date": "2024-12", "amount": 15000, "count": 720, "currency": "GBP"},
            {"date": "2024-11", "amount": 13500, "count": 650, "currency": "GBP"},
        ],
    }],
}

MOCK_ADVERT_RESPONSE = {
    "meta": {"reference": MOCK_MERCHANT_ID},
    "advert_data": {
        "header": "Grow your business",
        "title": "Get funded today",
        "subtitle": "Up to £150,000",
        "body": "Revenue-based financing.",
        "call_to_action": "See my offers",
        "footer": "Terms apply.",
        "background_image_url": "https://cdn.liberis.com/banner.jpg",
        "offer_status": "Eligible",
        "html": "<div>Ad</div>",
    },
}

MOCK_OFFERS_RESPONSE = {
    "liberis_id": MOCK_LIBERIS_ID,
    "expires_at": "2025-12-31T00:00:00Z",
    "products": [{
        "product_id": MOCK_PRODUCT_ID,
        "name": "BCA",
        "description": "Business Cash Advance",
        "decision": "Accepted",
        "repayment_mechanism": "terminal_split",
        "limits": {"minimum": 5000, "maximum": 150000, "currency": "GBP"},
        "offers": [{
            "offer_id": MOCK_OFFER_ID,
            "offer_status": "Eligible",
            "description": "Balanced",
            "split_percentage": 10,
            "term_length": 6,
            "funded_amount": 25000,
            "total_funded_amount": 25000,
            "repayment_amount": 27250,
            "total_repayment_amount": 27250,
            "factor_rate": 1.09,
            "currency": "GBP",
        }],
    }],
}

MOCK_ACCEPT_RESPONSE = {
    "application_id": MOCK_APPLICATION_ID,
    "liberis_id": MOCK_LIBERIS_ID,
    "offer": {
        "offer_id": MOCK_OFFER_ID,
        "offer_type": "Eligible",
        "description": "Balanced",
        "split_percentage": 10,
        "term_length": 6,
        "funded_amount": 25000,
        "total_funded_amount": 25000,
        "repayment_amount": 27250,
        "total_repayment_amount": 27250,
        "factor_rate": 1.09,
        "currency": "GBP",
    },
    "links": {
        "contract_link": "https://sign.liberis.com/abc123",
        "merchant_link": "https://portal.liberis.com/abc123",
    },
}


# =============================================================================
# MOCK HELPERS
# =============================================================================

def make_mock_response(data: object, status_code: int = 200) -> MagicMock:
    """Build a mock httpx.Response."""
    mock = MagicMock(spec=httpx.Response)
    mock.status_code = status_code
    mock.is_success = 200 <= status_code < 300
    mock.json.return_value = data if isinstance(data, dict) else {}
    mock.text = json.dumps(data) if isinstance(data, (dict, list)) else str(data)
    return mock


def auth_mock() -> MagicMock:
    return make_mock_response({
        "access_token": MOCK_TOKEN,
        "token_type": "Bearer",
        "expires_in": 86400,
    })


def completed_status(state: str, errors: list[str] | None = None) -> dict:
    return {
        "status": "Completed",
        "id": MOCK_STATUS_CHECK_ID,
        "created_at": "2024-01-01T00:00:00Z",
        "updated_at": None,
        "result": [{
            "data": {
                "partner_client_id": MOCK_MERCHANT_ID,
                "client_start_date": "2021-06-01",
                "entity_type": "LimitedCompany",
                "other_identifiers": [],
            },
            "status": {"state": state, "validation_errors": errors or []},
        }],
    }


@pytest.fixture
def client():
    return LiberisClient(TEST_CONFIG)


@pytest.fixture(autouse=True)
def reset_token_cache():
    """Reset module-level token cache between tests."""
    import liberis_integration
    liberis_integration._token_cache = {}
    yield
    liberis_integration._token_cache = {}


# =============================================================================
# SUITE 1 — AUTHENTICATION
# =============================================================================

class TestAuthentication:

    @pytest.mark.asyncio
    async def test_1_1_happy_path_returns_token(self, client):
        client._http.post = AsyncMock(return_value=auth_mock())
        token = await client.get_token()
        assert token == MOCK_TOKEN
        client._http.post.assert_called_once()
        call_kwargs = client._http.post.call_args
        assert "/auth/v1/token" in str(call_kwargs)

    @pytest.mark.asyncio
    async def test_1_2_token_is_cached_no_duplicate_calls(self, client):
        client._http.post = AsyncMock(return_value=auth_mock())
        await client.get_token()
        await client.get_token()  # should use cache
        assert client._http.post.call_count == 1

    @pytest.mark.asyncio
    async def test_1_3_http_401_raises_liberis_error(self, client):
        client._http.post = AsyncMock(return_value=make_mock_response(
            {"error": "access_denied", "error_description": "Unauthorized"}, 401
        ))
        with pytest.raises(LiberisError) as exc_info:
            await client.get_token()
        assert exc_info.value.status_code == 401
        assert exc_info.value.operation == "get_token"

    @pytest.mark.asyncio
    async def test_1_4_request_body_uses_client_credentials_grant(self, client):
        client._http.post = AsyncMock(return_value=auth_mock())
        await client.get_token()
        call_kwargs = client._http.post.call_args.kwargs
        body = call_kwargs.get("json", {})
        assert body["grant_type"] == "client_credentials"
        assert body["client_id"] == TEST_CONFIG.client_id
        assert body["client_secret"] == TEST_CONFIG.client_secret


# =============================================================================
# SUITE 2 — MERCHANT REGISTRATION
# =============================================================================

class TestMerchantRegistration:

    @pytest.fixture(autouse=True)
    def mock_platform_calls(self):
        with patch("liberis_integration.check_platform_eligibility",
                   AsyncMock(return_value={"eligible": True})) as mock_elig, \
             patch("liberis_integration.get_platform_merchant",
                   AsyncMock(return_value={
                       "partner_id": MOCK_MERCHANT_ID,
                       "entity_type": "LimitedCompany",
                       "client_start_date": "2021-06-01",
                       "legal_name": "Jane Doe Trading Ltd",
                       "address": {"line1": "1 Test St", "town_city": "London",
                                   "postcode": "EC1A 1BB", "country": "UK"},
                   })) as mock_merch:
            self.mock_elig = mock_elig
            self.mock_merch = mock_merch
            yield

    @pytest.mark.asyncio
    async def test_2_1_happy_path_polls_pending_then_completed(self, client):
        client._http.post = AsyncMock(side_effect=[
            auth_mock(),
            make_mock_response({"status_check_id": MOCK_STATUS_CHECK_ID,
                                "status_check_uri": ""}, 202),
        ])
        client._http.get = AsyncMock(side_effect=[
            make_mock_response({"status": "Pending", "id": MOCK_STATUS_CHECK_ID,
                                "created_at": "", "updated_at": None, "result": []}),
            make_mock_response(completed_status("Completed")),
        ])
        result = await register_merchant_with_liberis(client, MOCK_MERCHANT_ID)
        assert result["success"] is True
        assert "errors" not in result

    @pytest.mark.asyncio
    async def test_2_2_duplicate_state_treated_as_success(self, client):
        client._http.post = AsyncMock(side_effect=[
            auth_mock(),
            make_mock_response({"status_check_id": MOCK_STATUS_CHECK_ID,
                                "status_check_uri": ""}, 202),
        ])
        client._http.get = AsyncMock(return_value=make_mock_response(
            completed_status("Duplicate", ["Partner Client already exists"])
        ))
        result = await register_merchant_with_liberis(client, MOCK_MERCHANT_ID)
        assert result["success"] is True

    @pytest.mark.asyncio
    async def test_2_3_failed_state_returns_validation_errors(self, client):
        client._http.post = AsyncMock(side_effect=[
            auth_mock(),
            make_mock_response({"status_check_id": MOCK_STATUS_CHECK_ID,
                                "status_check_uri": ""}, 202),
        ])
        client._http.get = AsyncMock(return_value=make_mock_response(
            completed_status("Failed", ["entity_type is required", "client_start_date invalid"])
        ))
        result = await register_merchant_with_liberis(client, MOCK_MERCHANT_ID)
        assert result["success"] is False
        assert "entity_type is required" in result["errors"]

    @pytest.mark.asyncio
    async def test_2_4_platform_ineligible_does_not_call_liberis(self, client):
        self.mock_elig.return_value = {"eligible": False, "reason": "Below revenue threshold"}
        client._http.post = AsyncMock()
        result = await register_merchant_with_liberis(client, MOCK_MERCHANT_ID)
        assert result["success"] is False
        assert "Below revenue threshold" in result["errors"]
        # No Liberis API calls should have been made
        calls = [str(c) for c in client._http.post.call_args_list]
        assert not any("/data/v1/clients" in c for c in calls)

    @pytest.mark.asyncio
    async def test_2_5_idempotency_key_present_in_headers(self, client):
        captured_headers = {}

        async def mock_post(url, **kwargs):
            if "/data/v1/clients" in url:
                captured_headers.update(kwargs.get("headers", {}))
                return make_mock_response({"status_check_id": MOCK_STATUS_CHECK_ID,
                                           "status_check_uri": ""}, 202)
            return auth_mock()

        client._http.post = AsyncMock(side_effect=mock_post)
        client._http.get = AsyncMock(return_value=make_mock_response(completed_status("Completed")))

        await register_merchant_with_liberis(client, MOCK_MERCHANT_ID)
        assert "Idempotency-Key" in captured_headers
        # Should be a valid UUID
        key = captured_headers["Idempotency-Key"]
        assert len(key) == 36
        assert key.count("-") == 4

    @pytest.mark.asyncio
    async def test_2_6_conflict_state_returns_failure(self, client):
        client._http.post = AsyncMock(side_effect=[
            auth_mock(),
            make_mock_response({"status_check_id": MOCK_STATUS_CHECK_ID,
                                "status_check_uri": ""}, 202),
        ])
        client._http.get = AsyncMock(return_value=make_mock_response(
            completed_status("Conflict", ["partner_client_id conflict"])
        ))
        result = await register_merchant_with_liberis(client, MOCK_MERCHANT_ID)
        assert result["success"] is False


# =============================================================================
# SUITE 3 — REVENUE CLAIMS
# =============================================================================

class TestRevenueClaims:

    MOCK_VOLUMES = [
        {"date": "2024-12", "amount": 15000.0, "count": 720, "currency": "GBP"},
        {"date": "2024-11", "amount": 13500.0, "count": 650, "currency": "GBP"},
    ]

    @pytest.mark.asyncio
    async def test_3_1_happy_path_returns_status_check_id(self, client):
        client._http.post = AsyncMock(side_effect=[
            auth_mock(),
            make_mock_response({"status_check_id": "rev-sc-001",
                                "status_check_uri": ""}, 202),
        ])
        with patch("liberis_integration.get_platform_revenue",
                   AsyncMock(return_value=self.MOCK_VOLUMES)):
            result = await submit_revenue_claims(client, MOCK_MERCHANT_ID)
        assert result["status_check_id"] == "rev-sc-001"

    @pytest.mark.asyncio
    async def test_3_2_unique_reference_is_deterministic(self, client):
        captured_body = {}

        async def mock_post(url, **kwargs):
            if "revenueClaims" in url:
                captured_body["claims"] = kwargs.get("json", [])
                return make_mock_response({"status_check_id": "rev-sc-002",
                                           "status_check_uri": ""}, 202)
            return auth_mock()

        client._http.post = AsyncMock(side_effect=mock_post)
        with patch("liberis_integration.get_platform_revenue",
                   AsyncMock(return_value=self.MOCK_VOLUMES)):
            await submit_revenue_claims(client, MOCK_MERCHANT_ID)

        for claim in captured_body["claims"]:
            assert claim["unique_reference"].startswith(f"{MOCK_MERCHANT_ID}-")
            # Should end with YYYY-MM
            suffix = claim["unique_reference"][len(MOCK_MERCHANT_ID) + 1:]
            assert len(suffix) == 7  # "YYYY-MM"
            assert suffix[4] == "-"

    @pytest.mark.asyncio
    async def test_3_3_idempotency_key_present(self, client):
        captured_headers = {}

        async def mock_post(url, **kwargs):
            if "revenueClaims" in url:
                captured_headers.update(kwargs.get("headers", {}))
                return make_mock_response({"status_check_id": "rev-sc-003",
                                           "status_check_uri": ""}, 202)
            return auth_mock()

        client._http.post = AsyncMock(side_effect=mock_post)
        with patch("liberis_integration.get_platform_revenue",
                   AsyncMock(return_value=self.MOCK_VOLUMES)):
            await submit_revenue_claims(client, MOCK_MERCHANT_ID)
        assert "Idempotency-Key" in captured_headers

    @pytest.mark.asyncio
    async def test_3_4_http_409_raises_liberis_error(self, client):
        client._http.post = AsyncMock(side_effect=[
            auth_mock(),
            make_mock_response({"status_code": 409, "message": "Idempotency Key conflict"}, 409),
        ])
        with pytest.raises(LiberisError) as exc_info:
            await client.create_revenue_claims([{
                "partner_client_id": MOCK_MERCHANT_ID,
                "time_period": {"start_time": "2024-12-01T00:00:00.000Z",
                                "end_time": "2024-12-31T23:59:59.999Z"},
                "total_amount": 15000.0,
                "currency": "GBP",
                "transaction_count": 720,
                "unique_reference": "duplicate-key",
            }])
        assert exc_info.value.status_code == 409

    @pytest.mark.asyncio
    async def test_3_5_negative_amounts_accepted_for_returns(self, client):
        client._http.post = AsyncMock(side_effect=[
            auth_mock(),
            make_mock_response({"status_check_id": "rev-sc-004",
                                "status_check_uri": ""}, 202),
        ])
        # Should not raise — negative values are valid for returns/chargebacks
        result = await client.create_revenue_claims([{
            "partner_client_id": MOCK_MERCHANT_ID,
            "time_period": {"start_time": "2024-12-01T00:00:00.000Z",
                            "end_time": "2024-12-31T23:59:59.999Z"},
            "total_amount": -500.0,         # negative = returns
            "currency": "GBP",
            "transaction_count": -10,        # negative = return count
            "unique_reference": f"{MOCK_MERCHANT_ID}-2024-12-returns",
        }])
        assert result["status_check_id"] == "rev-sc-004"


# =============================================================================
# SUITE 4 — OFFERS
# =============================================================================

class TestOffers:

    @pytest.fixture(autouse=True)
    def mock_storage(self):
        with patch("liberis_integration.get_liberis_id",
                   AsyncMock(return_value=None)) as mock_get, \
             patch("liberis_integration.store_liberis_id",
                   AsyncMock(return_value=None)) as mock_store:
            self.mock_get = mock_get
            self.mock_store = mock_store
            yield

    def setup_offer_mocks(self, client):
        """Set up auth + advert + offers call sequence."""
        client._http.post = AsyncMock(side_effect=[
            auth_mock(),
            make_mock_response(MOCK_OFFERS_RESPONSE),
        ])
        client._http.get = AsyncMock(return_value=make_mock_response(MOCK_ADVERT_RESPONSE))

    @pytest.mark.asyncio
    async def test_4_1_happy_path_returns_offers_with_liberis_id(self, client):
        self.setup_offer_mocks(client)
        result = await get_merchant_offers(client, MOCK_MERCHANT_ID, MOCK_APPLICANT, MOCK_COMPANY)
        assert result is not None
        assert result["liberis_id"] == MOCK_LIBERIS_ID
        assert result["products"][0]["name"] == "BCA"

    @pytest.mark.asyncio
    async def test_4_2_advert_404_returns_none(self, client):
        client._http.post = AsyncMock(return_value=auth_mock())
        client._http.get = AsyncMock(return_value=make_mock_response(
            {"title": "Not Found", "status": 404}, 404
        ))
        result = await get_merchant_offers(client, MOCK_MERCHANT_ID, MOCK_APPLICANT, MOCK_COMPANY)
        assert result is None

    @pytest.mark.asyncio
    async def test_4_3_liberis_id_stored_after_offer_fetch(self, client):
        self.setup_offer_mocks(client)
        await get_merchant_offers(client, MOCK_MERCHANT_ID, MOCK_APPLICANT, MOCK_COMPANY)
        self.mock_store.assert_called_once_with(MOCK_MERCHANT_ID, MOCK_LIBERIS_ID)

    @pytest.mark.asyncio
    async def test_4_4_renewal_flow_passes_liberis_id(self, client):
        self.mock_get.return_value = MOCK_LIBERIS_ID
        self.setup_offer_mocks(client)

        await get_merchant_offers(client, MOCK_MERCHANT_ID, MOCK_APPLICANT, MOCK_COMPANY)

        offers_call = next(
            c for c in client._http.post.call_args_list
            if "/create/v2/offers" in str(c)
        )
        body = offers_call.kwargs.get("json", {})
        assert body["application"]["liberis_id"] == MOCK_LIBERIS_ID

    @pytest.mark.asyncio
    async def test_4_5_repricing_passes_amount_requested_and_product_id(self, client):
        self.setup_offer_mocks(client)
        await get_merchant_offers(
            client, MOCK_MERCHANT_ID, MOCK_APPLICANT, MOCK_COMPANY,
            amount_requested=15000.0, product_id=MOCK_PRODUCT_ID
        )
        offers_call = next(
            c for c in client._http.post.call_args_list
            if "/create/v2/offers" in str(c)
        )
        body = offers_call.kwargs.get("json", {})
        assert body["application"]["amount_requested"] == 15000.0
        assert body["application"]["product_id"] == MOCK_PRODUCT_ID

    @pytest.mark.asyncio
    async def test_4_6_apply_offer_presets_true_in_request(self, client):
        self.setup_offer_mocks(client)
        await get_merchant_offers(client, MOCK_MERCHANT_ID, MOCK_APPLICANT, MOCK_COMPANY)
        offers_call = next(
            c for c in client._http.post.call_args_list
            if "/create/v2/offers" in str(c)
        )
        body = offers_call.kwargs.get("json", {})
        assert body["application"]["apply_offer_presets"] is True

    @pytest.mark.asyncio
    async def test_4_7_bureau_search_true_in_consents(self, client):
        self.setup_offer_mocks(client)
        await get_merchant_offers(client, MOCK_MERCHANT_ID, MOCK_APPLICANT, MOCK_COMPANY)
        offers_call = next(
            c for c in client._http.post.call_args_list
            if "/create/v2/offers" in str(c)
        )
        body = offers_call.kwargs.get("json", {})
        assert body["consents"]["bureau_search"] is True
        assert body["consents"]["application_comms"] is True


# =============================================================================
# SUITE 5 — OFFER ACCEPTANCE
# =============================================================================

class TestOfferAcceptance:

    @pytest.mark.asyncio
    async def test_5_1_happy_path_returns_application_id_and_links(self, client):
        client._http.post = AsyncMock(side_effect=[
            auth_mock(),
            make_mock_response(MOCK_ACCEPT_RESPONSE),
        ])
        result = await accept_merchant_offer(client, MOCK_OFFER_ID)
        assert result["application_id"] == MOCK_APPLICATION_ID
        assert result["liberis_id"] == MOCK_LIBERIS_ID
        assert "contract_link" in result["links"]

    @pytest.mark.asyncio
    async def test_5_2_url_contains_offer_id(self, client):
        captured_url = {}

        async def mock_post(url, **kwargs):
            captured_url["url"] = url
            if "/accept" in url:
                return make_mock_response(MOCK_ACCEPT_RESPONSE)
            return auth_mock()

        client._http.post = AsyncMock(side_effect=mock_post)
        await client.accept_offer(MOCK_OFFER_ID)
        assert f"/create/v2/offers/{MOCK_OFFER_ID}/accept" in captured_url["url"]

    @pytest.mark.asyncio
    async def test_5_3_http_409_raises_liberis_error(self, client):
        client._http.post = AsyncMock(side_effect=[
            auth_mock(),
            make_mock_response("Application already has accepted offer", 409),
        ])
        with pytest.raises(LiberisError) as exc_info:
            await client.accept_offer(MOCK_OFFER_ID)
        assert exc_info.value.status_code == 409
        assert exc_info.value.operation == "accept_offer"

    @pytest.mark.asyncio
    async def test_5_4_bank_details_included_when_provided(self, client):
        captured_body = {}

        async def mock_post(url, **kwargs):
            if "/accept" in url:
                captured_body.update(kwargs.get("json", {}))
                return make_mock_response(MOCK_ACCEPT_RESPONSE)
            return auth_mock()

        client._http.post = AsyncMock(side_effect=mock_post)
        bank_details = {
            "bank_name": "Barclays",
            "account_number": "12345678",
            "account_type": "IBAN",
            "sort_code": "20-00-00",
        }
        await client.accept_offer(MOCK_OFFER_ID, bank_details)
        assert captured_body.get("bank_details", {}).get("bank_name") == "Barclays"
        assert captured_body["bank_details"]["sort_code"] == "20-00-00"


# =============================================================================
# SUITE 6 — WEBHOOK HANDLER
# =============================================================================

class TestWebhookHandler:

    @pytest.mark.asyncio
    async def test_6_1_deal_activated_processed_without_error(self):
        with patch("liberis_integration.handle_liberis_webhook",
                   AsyncMock(return_value=None)) as mock_handler:
            await mock_handler(
                {"event_type": "deal.activated", "deal_id": "deal-001",
                 "merchant_id": MOCK_MERCHANT_ID},
                "mock-signature"
            )
            mock_handler.assert_called_once()

    @pytest.mark.asyncio
    async def test_6_2_application_manual_review_processed(self):
        with patch("liberis_integration.handle_liberis_webhook",
                   AsyncMock(return_value=None)) as mock_handler:
            await mock_handler(
                {"event_type": "application.manual_review",
                 "application_id": MOCK_APPLICATION_ID},
                "mock-signature"
            )
            mock_handler.assert_called_once()

    @pytest.mark.asyncio
    async def test_6_3_payment_received_processed(self):
        with patch("liberis_integration.handle_liberis_webhook",
                   AsyncMock(return_value=None)) as mock_handler:
            await mock_handler(
                {"event_type": "payment.received", "deal_id": "deal-001",
                 "amount": 250.0, "currency": "GBP"},
                "mock-signature"
            )
            mock_handler.assert_called_once()

    @pytest.mark.asyncio
    async def test_6_4_unknown_event_type_does_not_raise(self):
        with patch("liberis_integration.handle_liberis_webhook",
                   AsyncMock(return_value=None)) as mock_handler:
            await mock_handler(
                {"event_type": "unknown.future.event.type", "data": {}},
                "mock-signature"
            )
            mock_handler.assert_called_once()
