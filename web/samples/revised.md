# Retry client

The retry client sends one request and retries it when the server answers with a
5xx status or closes the socket. Each attempt waits longer than the last, up to
a ceiling the caller sets.

## Why it matters

A connection to our billing service fails about once in four thousand requests.
Without a retry, that rate reaches a customer as a failed checkout. With one, it
reaches a log line.

Backoff matters as much as the retry itself. Ten clients that all retry after
exactly one second turn a brief outage into a second one, so each wait gets a
random offset of up to half its length.

## Limits

Only idempotent verbs are retried. A POST that created a row on the first
attempt would create a second row on the next, and the client cannot tell the
two cases apart from a timeout.

The budget is per request, not per process. A caller that sets four attempts and
a two second ceiling waits at most seven seconds before the error surfaces.
