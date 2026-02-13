"""
Browser session methods for Firecrawl v2 API.

Provides create, execute, delete, and list operations for browser sessions.
"""

from typing import Any, Dict, List, Literal, Optional

from ..types import (
    BrowserCreateResponse,
    BrowserExecuteResponse,
    BrowserDeleteResponse,
    BrowserListResponse,
)
from ..utils.http_client import HttpClient
from ..utils.error_handler import handle_response_error


def _normalize_browser_create_response(payload: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(payload)
    if "cdpUrl" in out and "cdp_url" not in out:
        out["cdp_url"] = out["cdpUrl"]
    if "liveViewUrl" in out and "live_view_url" not in out:
        out["live_view_url"] = out["liveViewUrl"]
    return out


def _normalize_browser_list_response(payload: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(payload)
    if "sessions" in out and isinstance(out["sessions"], list):
        normalized_sessions = []
        for s in out["sessions"]:
            ns = dict(s)
            if "cdpUrl" in ns and "cdp_url" not in ns:
                ns["cdp_url"] = ns["cdpUrl"]
            if "liveViewUrl" in ns and "live_view_url" not in ns:
                ns["live_view_url"] = ns["liveViewUrl"]
            if "streamWebView" in ns and "stream_web_view" not in ns:
                ns["stream_web_view"] = ns["streamWebView"]
            if "createdAt" in ns and "created_at" not in ns:
                ns["created_at"] = ns["createdAt"]
            if "lastActivity" in ns and "last_activity" not in ns:
                ns["last_activity"] = ns["lastActivity"]
            normalized_sessions.append(ns)
        out["sessions"] = normalized_sessions
    return out


def browser(
    client: HttpClient,
    *,
    ttl_total: Optional[int] = None,
    ttl_without_activity: Optional[int] = None,
    stream_web_view: Optional[bool] = None,
) -> BrowserCreateResponse:
    """Create a new browser session.

    Args:
        client: HTTP client instance
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

    resp = client.post("/v2/browser", body)
    if not resp.ok:
        handle_response_error(resp, "create browser session")
    payload = _normalize_browser_create_response(resp.json())
    return BrowserCreateResponse(**payload)


def browser_execute(
    client: HttpClient,
    session_id: str,
    code: str,
    *,
    language: Literal["python", "js"] = "python",
) -> BrowserExecuteResponse:
    """Execute code in a browser session.

    Args:
        client: HTTP client instance
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

    resp = client.post(f"/v2/browser/{session_id}/execute", body)
    if not resp.ok:
        handle_response_error(resp, "execute browser code")
    return BrowserExecuteResponse(**resp.json())


def delete_browser(
    client: HttpClient,
    session_id: str,
) -> BrowserDeleteResponse:
    """Delete a browser session.

    Args:
        client: HTTP client instance
        session_id: Browser session ID

    Returns:
        BrowserDeleteResponse
    """
    resp = client.delete(f"/v2/browser/{session_id}")
    if not resp.ok:
        handle_response_error(resp, "delete browser session")
    return BrowserDeleteResponse(**resp.json())


def list_browsers(
    client: HttpClient,
    *,
    status: Optional[Literal["active", "destroyed"]] = None,
) -> BrowserListResponse:
    """List browser sessions.

    Args:
        client: HTTP client instance
        status: Filter by session status ("active" or "destroyed")

    Returns:
        BrowserListResponse with list of sessions
    """
    endpoint = "/v2/browser"
    if status is not None:
        endpoint = f"{endpoint}?status={status}"

    resp = client.get(endpoint)
    if not resp.ok:
        handle_response_error(resp, "list browser sessions")
    payload = _normalize_browser_list_response(resp.json())
    return BrowserListResponse(**payload)
