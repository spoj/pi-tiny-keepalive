# pi-tiny-keepalive

A Pi package that lets the model keep an unattended session from stalling.

A turn can end and leave the session idle with nobody to prompt it: Pi gave up retrying a provider error, a usage limit was hit, or the model ended its turn to wait for background work. Once armed, keepalive wakes the session after each idle period so the model can check on things and carry on.

## Tool

- `keepalive({ action: "arm", idle_minutes })` arms keepalive; `idle_minutes` defaults to 30. Arming again changes the period.
- `keepalive({ action: "disarm" })` disarms it.

While armed, each time the session has settled and stayed idle for `idle_minutes`, keepalive sends a displayed message that starts a turn:

```text
keepalive: idle 30m, now 2026-10-04T08:12Z
keepalive: idle 30m, now 2026-10-04T08:42Z; last turn failed: 429 Too Many Requests
```

The message only reports the wait; the model decides whether to continue or end its turn again. Any run resets the period, so monitor updates and other wake-ups delay the next keepalive. If the session is busy outside a run when the period ends, for example compacting, keepalive waits another period.

The status line shows `keepalive 30m` while armed.

## Disarming

Keepalive stays armed until one of these happens:

- the model disarms it;
- user input arrives: an interactive or RPC prompt, steer, or follow-up;
- the user runs a `!` bash command;
- a run is interrupted, for example with Escape;
- the session starts, reloads, or is replaced.

Messages from extensions do not disarm it: `pi.sendUserMessage()` input, which Pi marks with source `extension`, and custom messages such as monitor updates. Programs that act as the user count as the user: Pi's command-line messages, RPC clients, and keystrokes sent into the terminal.

State lives in memory, so a restarted Pi starts disarmed.

## Limits

Keepalive only wakes an idle session. It does not interrupt a running tool, and it cannot help once the Pi process has exited.

## Install

```bash
pi install git:github.com/spoj/pi-tiny-keepalive
```

Or try it locally:

```bash
pi -e ./src/index.ts
```

## Development

```bash
npm install
npm run check
```
