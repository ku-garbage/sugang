# API findings

## Architecture

The browser calls Sugang application endpoints directly. NetFUNNEL is a
separate admission gate; it is not an HTTP proxy for the application API.

```text
Browser -> NetFUNNEL nfStart(segment)
        <- callback permits execution
Browser -> sugang.korea.ac.kr application endpoint
Browser -> NetFUNNEL nfStop(segment)
```

The frontend uses jQuery and Tabulator. No WebSocket or EventSource traffic was
observed.

## Observed endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/d/l/loginCheck` | Login |
| POST | `/d/c/lectList` | Course search |
| POST | `/d/s/add` | Register a course |
| POST | `/d/s/del` | Delete a registered course |
| GET | `/d/s/list` | Current registered-course list |
| POST | `/d/c/cache` | Course/combination metadata cache |
| POST | `/d/c/reload` | Session keepalive |
| POST | `/d/m/macroInit` | Initialize macro CAPTCHA state |
| GET | `/d/m/macroImg` | Fetch macro CAPTCHA image |
| POST | `/d/m/macroCheck` | Submit the four-character answer |

## Search

The search form (`#sForm`) is serialized and posted as
`application/x-www-form-urlencoded` to `/d/c/lectList`. Result rows contain a
hidden `PARAMS` field whose observed add form is:

```text
COURSE_CODE@SECTION
```

The search request is gated by the NetFUNNEL `sugang_search` segment.

## Add and delete payloads

Add requests send:

```text
params = COURSE_CODE@SECTION
hp = SHA256(params + "@" + page_nonce)
```

Delete requests use the same construction, with an observed parameter form of:

```text
COURSE_CODE@SECTION@DEPARTMENT
```

The page supplies a randomized custom-header name and a page nonce as Base64
data attributes on `#divider`. JavaScript decodes them, includes the nonce in
that custom header, and uses the nonce to calculate `hp`. A `fake=Date.now()`
query parameter acts as a cache buster.

The add/delete flow is gated by the NetFUNNEL `sugang_action` segment. The
NetFUNNEL key is not visibly attached to the application request by the page
JavaScript.

## Application result handling

HTTP responses were normally HTTP 200; the JSON `code` carries application
status.

| Code | Observed/implemented meaning |
|---|---|
| `200` | Success; show a message and reload `/d/s/list` |
| `118` | Open macro-prevention challenge |
| `999` | Session invalid; log out |
| `500` | Rejection such as already registered or ineligible |
| `501` | Observed when the enrollment quota was full |

The authenticated page displays a 15-minute session timer and exposes
`/d/c/reload` as its manual keepalive. This client does not keep the session
alive in the background. Instead, a `999` JSON result—or the same JSON result
returned while loading the macro page or image—clears the session cookies,
logs in again, reconstructs the course-page proof, and replays the interrupted
action once.

Capacity, schedule conflicts, credit limits, eligibility, and duplicate
registration are decided by the server. The browser only performs basic input
validation and displays returned messages.

## Macro challenge

An add response with code `118` opens `/p/m/macroMain`, which loads the macro
UI and JavaScript. The exchange is:

```text
POST /d/m/macroInit
  -> {"failCnt":10,"code":"200"}

GET /d/m/macroImg?fake=<timestamp>
  -> image/gif

POST /d/m/macroCheck?fake=<timestamp>
body: secNumber=<four characters>
  -> {"failCnt":10,"code":"200","message":""}
```

No client-visible challenge ticket or ID is returned. On success,
`fnMcrNext()` calls `jcMac.onAction()`, which retries the original add request
with the same body, hash, and headers. This supports server-side session state
rather than a client-carried macro ticket.

In the second capture, the 49th observed add call returned `118`; the preceding
48 included one success and many application-level failures. This suggests an
attempt counter rather than a success counter. One capture cannot determine
whether the threshold is fixed or randomized, or whether the state is scoped
to a login session, account, IP address, or a combination.

NetFUNNEL is separate: its `key` values are ticket-like, but the macro CAPTCHA
does not visibly exchange or attach a NetFUNNEL key.
