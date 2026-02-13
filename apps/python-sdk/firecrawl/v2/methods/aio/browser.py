"""
Async browser session methods for Firecrawl v2 API.

Provides async create, execute, delete, and list operations for browser sessions.
"""

from typing import Any, Dict, List, Literal, Optional

from ...types import (
    BrowserCreateResponse,
    BrowserExecuteResponse,
    BrowserDeleteResponse,
    BrowserListResponse,
)
from ...utils.http_client_async import AsyncHttpClient


def _normalize_browser_create_response(payload: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(payload)
    if "cdpUrl" in out and "cdp_url" not in out:
        out["cdp_url"] = out["cdpUrl"]
    return out


def _normalize_browser_list_response(payload: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(payload)
    if "sessions" in out and isinstance(out["sessions"], list):
        normalized_sessions = []
        for s in out["sessions"]:
            ns = dict(s)
            if "cdpUrl" in ns and "cdp_url" not in ns:
                ns["cdp_url"] = ns["cdpUrl"]
            if "streamWebView" in ns and "stream_web_view" not in ns:
                ns["stream_web_view"] = ns["streamWebView"]
            if "createdAt" in ns and "created_at" not in ns:
                ns["created_at"] = ns["createdAt"]
            if "lastActivity" in ns and "last_activity" not in ns:
                ns["last_activity"] = ns["lastActivity"]
            normalized_sessions.append(ns)
        out["sessions"] = normalized_sessions
    return out


async def browser(
    client: AsyncHttpClient,
    *,
    ttl_total: Optional[int] = None,
    ttl_without_activity: Optional[int] = None,
    stream_web_view: Optional[bool] = None,
) -> BrowserCreateResponse:
    """Create a new browser session.

    Args:
        client: Async HTTP client instance
        ttl_total: Total time-to-live in seconds (30-3600, default 300)
        ttl_without_activity: TTL without activity in seconds (10-3600)
        stream_web_view: Whether to enable webview streaming

    Returns:
        BrowserCreateResponse with session id and CDP URL
    """
    body: Dict[str, Any] = {}
    if ttl_total is not None:
        body["ttlTotal"] = ttl_total
    if ttl_without_activity is not None:
        body["ttlWithoutActivity"] = ttl_without_activity
    if stream_web_view is not None:
        body["streamWebView"] = stream_web_view

    resp = await client.post("/v2/browser", body)
    payload = _normalize_browser_create_response(resp.json())
    return BrowserCreateResponse(**payload)


async def browser_execute(
    client: AsyncHttpClient,
    session_id: str,
    code: str,
    *,
    language: Literal["python", "js"] = "python",
) -> BrowserExecuteResponse:
    """Execute code in a browser session.

    Args:
        client: Async HTTP client instance
        session_id: Browser session ID
        code: Code to execute
        language: Programming language ("python" or "js")

    Returns:
        BrowserExecuteResponse with execution result
    """
    body: Dict[str, Any] = {
        "code": code,
        "language": language,
    }

    resp = await client.post(f"/v2/browser/{session_id}/execute", body)
    return BrowserExecuteResponse(**resp.json())


async def delete_browser(
    client: AsyncHttpClient,
    session_id: str,
) -> BrowserDeleteResponse:
    """Delete a browser session.

    Args:
        client: Async HTTP client instance
        session_id: Browser session ID

    Returns:
        BrowserDeleteResponse
    """
    resp = await client.delete(f"/v2/browser/{session_id}")
    return BrowserDeleteResponse(**resp.json())


async def list_browsers(
    client: AsyncHttpClient,
    *,
    status: Optional[Literal["active", "destroyed"]] = None,
) -> BrowserListResponse:
    """List browser sessions.

    Args:
        client: Async HTTP client instance
        status: Filter by session status ("active" or "destroyed")

    Returns:
        BrowserListResponse with list of sessions
    """
    endpoint = "/v2/browser"
    if status is not None:
        endpoint = f"{endpoint}?status={status}"

    resp = await client.get(endpoint)
    payload = _normalize_browser_list_response(resp.json())
    return BrowserListResponse(**payload)
