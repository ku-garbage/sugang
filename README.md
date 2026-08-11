# Sugang client

A command-line client for ordered course registration with automatic CAPTCHA
recognition.

## Requirements

- Node.js 20 or newer
- Rust and Cargo
- A C++17 compiler
- ImageMagick
- Times New Roman Bold, or another compatible font configured with
  `LMS_CAPTCHA_FONT`

## Run

Clone the repository and build the native CAPTCHA recognizer:

```bash
npm run build:native
```

Set your LMS credentials without putting the password in command history:

```bash
export LMS_ID="your-student-id"
printf 'Password: '
read -rs LMS_PWD && export LMS_PWD
printf '\n'
```

Enter courses in the order you want them attempted:

```bash
npm run enter -- COSE211@01 MATH161@02
```

When finished:

```bash
unset LMS_PWD
```

Course arguments must use `COURSE_CODE@SECTION`. Duplicate courses and command
options are rejected.

## What the command does

The command logs in once and processes the ordered course queue in one session.

| Result | Behavior |
|---|---|
| `200 / registered` | Remove the course from the queue and continue |
| `501 / full` | Mark it as not registered, remove it immediately, and continue |
| `500 / rejected` | Retry the same course immediately |
| `118 / macro required` | Solve the CAPTCHA automatically and retry the same course |
| CAPTCHA attempts exhausted | Mark it as not registered and continue |
| `999 / session expired` | Log in and replay once; stop if the renewed session also expires |

A full course is never retried within the current command. Each new invocation
creates a new queue, however, so wrapping `npm run enter` in an outer shell loop
would submit full courses again. Avoid an outer loop when `501 / full` should be
terminal.

Ordinary `500 / rejected` responses retry without an internal count limit. Stop
the command with `Ctrl-C` when needed. The client handles `SIGINT` and `SIGTERM`,
logs out, clears local credentials and cookies, and closes the CAPTCHA solver.

## Automatic CAPTCHA handling

When the server returns `118`, the client downloads the 100 x 100 GIF, recognizes
its four-character answer locally, submits it, and replays the interrupted course
request.

The solver allows at most three guesses per challenge by default. It retries only
the observed wrong-answer code `500` and respects the server's `failCnt`. CAPTCHA
recognition itself does not use the network.

If the default font or ImageMagick command is unavailable, configure them before
running:

```bash
export LMS_CAPTCHA_FONT="/path/to/compatible-bold-font.ttf"
export LMS_IMAGEMAGICK_COMMAND="magick"
```

## Output

Interactive terminals show a live status table. Each course finishes as one of:

- registered
- full — not registered
- CAPTCHA not solved
- session expired

A remote logout error is reported as a warning and does not overwrite an already
confirmed registration.

## Other commands

Decode a saved CAPTCHA:

```bash
npm run decode -- samples/macro-vl7x.png
```

Evaluate the saved fixture corpus:

```bash
npm run evaluate
```

Run the native benchmark:

```bash
npm run benchmark:native
```

Collecting new CAPTCHA samples is separate from course registration. The command
prompts for a password when `LMS_PWD` is absent:

```bash
node src/client.js --id your-student-id --out samples/macro-one.gif
```

## Development

Run the complete native and Node test suites with:

```bash
npm test
```

Tests use local HTTP fakes and do not contact the live registration service.
Generated native build directories are ignored because compiled artifacts may
contain local filesystem paths.

Additional investigation notes are available in:

- [Application API](docs/api.md)
- [CAPTCHA image](docs/image.md)
- [OCR experiments](docs/ocr.md)

Raw HAR captures and credentials are intentionally excluded from the repository.
