"""Shared retry helper for transient HTTP failures across NCBI/VEP/PMC/CrossRef calls.

`@retry_transient_http` decorates an async (or sync) HTTP-calling function and
retries it on timeouts, network errors, 429, and 5xx — but lets 4xx
(other than 429) fail-fast, since most such errors indicate malformed input
or unindexed identifiers and won't succeed on retry.
"""

import httpx
from tenacity import retry, retry_if_exception, stop_after_attempt, wait_exponential


def is_retryable_http(exc: BaseException) -> bool:
    if isinstance(exc, httpx.TimeoutException | httpx.NetworkError):
        return True
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code in {429, 500, 502, 503, 504}
    return False


retry_transient_http = retry(
    stop=stop_after_attempt(5),
    wait=wait_exponential(multiplier=1, min=1, max=30),
    retry=retry_if_exception(is_retryable_http),
    reraise=True,
)
