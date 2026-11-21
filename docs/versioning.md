# API versioning policy

This page describes how the StellarPOS API is versioned and how breaking changes are rolled out.
The notice period in [Deprecation timeline](#deprecation-timeline) is a **proposal**; the
maintainers can change it.

## URL versioning

The major version is part of the path: `/api/v1/...`. Every response from a versioned route
carries an `X-API-Version` header (for example `X-API-Version: 1`) so a client can confirm which
version answered.

- A request to a version the server does not know, such as `/api/v9/products`, gets a `404`
  whose `error` message lists the supported versions.
- `/health` is unversioned.
- Only the major version appears in the URL. Minor and patch changes are always backward
  compatible and ship inside the current major version (see the changelog for release notes).

## Breaking and non-breaking changes

**Non-breaking** (may ship in the current version at any time):

- Adding a new endpoint.
- Adding an optional request field or query parameter.
- Adding a field to a response body.
- Adding a new value to an error `details` list, or a new HTTP header.
- Fixing a bug so the API matches this documentation.
- Making validation more lenient.

Clients must ignore response fields they do not recognise.

**Breaking** (require a new major version):

- Removing or renaming an endpoint, a field, or a query parameter.
- Changing a field's type, format or unit (for example cents to decimal amounts).
- Making an optional request field required, or making validation stricter for existing input.
- Changing the response envelope (`success`, `data`, `error`, `pagination`).
- Changing the meaning of an existing status code, or the minimum role for a route.
- Changing authentication or token behaviour.

## Deprecation timeline

Proposal (adjustable by the maintainers):

1. **Announce.** A new major version is released. The old one keeps working and is marked
   deprecated in the changelog and in this documentation.
2. **Deprecation period.** The old version stays available for at least **6 months** after the
   announcement. It receives security and critical bug fixes only.
3. **Sunset.** After the period ends, the old version may be removed. Requests then get the
   `404` response described above.

Removal dates are announced in the changelog before they take effect. No version is deprecated
today.

## Deprecation headers

Once a version is deprecated, its responses include:

| Header | Meaning |
|---|---|
| `Deprecation` | The version is deprecated ([RFC 9745](https://www.rfc-editor.org/rfc/rfc9745)). Value is `@<unix seconds>` for the deprecation date, or `true` when no date is set. |
| `Sunset` | The HTTP-date after which the version may stop working ([RFC 8594](https://www.rfc-editor.org/rfc/rfc8594)). Only sent when a sunset date has been set. |

Clients should log or alert on these headers so a retirement is not a surprise.

## Migration guide template

Copy this section into `docs/migrating-v1-to-v2.md` when v2 is introduced.

```md
# Migrating from v1 to v2

- Released: <date>
- v1 deprecated: <date>
- v1 sunset: <date or "not yet announced">

## Summary
<One paragraph on what changed and why.>

## Breaking changes
| Area | v1 | v2 | What to do |
|---|---|---|---|
| <endpoint or field> | <old behaviour> | <new behaviour> | <action for clients> |

## New in v2
- <additive feature>

## Migration steps
1. Change the base URL from `/api/v1` to `/api/v2`.
2. <Apply each breaking change above.>
3. Check that responses carry `X-API-Version: 2`.

## Testing your migration
<How to verify, including any staging environment or test data.>

## Getting help
<Where to ask questions or report problems.>
```
