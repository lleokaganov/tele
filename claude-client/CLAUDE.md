# CLAUDE.md — running wschat as an AI-agent ↔ human bridge

This file is for **AI coding agents** (Claude and the like). It explains how
to stand up `wschat` so you, the agent, can hold a real-time conversation
with a human over this end-to-end-encrypted messenger — using the exact same
relay and crypto as every other client.

## The concept

`wschat` is a **generic encrypted bridge**. It owns a keypair, connects to
the relay, pairs with exactly one peer, and then:

```
   your text  ──>  stdin / --watch file  ──>  [encrypt]  ──>  relay  ──>  human
   human text  <──  stdout (one line per msg)  <──  [decrypt]  <──  relay  <──
```

So from your side it is two plain-text channels:

- **Outgoing**: write a line → it is encrypted and sent.
- **Incoming**: a decrypted line appears on stdout as `<nick>: text`.

No crypto knowledge is needed at your level. You only move plain text in and
out. The encryption, signing, routing, and pairing all happen inside
`wschat`.

## One-time setup

1. **Make your keypair and invite.**

   ```bash
   cargo run --release -- keygen
   ```

   This prints (to stderr) your `WSCHAT_X_SEED`, `WSCHAT_ED_SEED`, your `id`,
   and your `K0...` **invite**. Save the two seeds — they are your stable
   identity. Give the `K0...` invite to the human (they add you as a
   contact in their app).

2. **Get the human's invite.** Ask them to send you their `K0...` string
   (from their app's "share/invite" or from their own `wschat keygen`). That
   goes in `WSCHAT_PEER_QR`.

3. **Know the relay endpoint and its public keys.** Use the deployment's
   `WS_URL` plus `WSCHAT_SERVER_X_PUB` / `WSCHAT_SERVER_ED_PUB` (these are
   public keys; the built-in defaults may already match your deployment).

## The agent pattern (background bridge + watch file + log)

Run `wschat` as a **long-lived background process**. Feed outgoing messages
through a watch file, and read incoming messages from the process's stdout
log.

```bash
# 1. Pick paths.
SAY=/tmp/wschat.say.txt          # you append outgoing lines here
LOG=/tmp/wschat.log              # incoming "<nick>: text" lines land here
: > "$SAY"                       # start empty (wschat only sends lines
                                 # appended AFTER it starts)

# 2. Launch in the background with WSCHAT_WATCH = the say-file,
#    redirect stdout (incoming) + stderr (status) to the log.
WSCHAT_X_SEED=<hex32> \
WSCHAT_ED_SEED=<hex32> \
WSCHAT_PEER_QR=K0...<human invite> \
WSCHAT_NICK="claude" \
WS_URL=wss://your-relay.example/ws \
WSCHAT_SERVER_X_PUB=<hex32> \
WSCHAT_SERVER_ED_PUB=<hex32> \
WSCHAT_WATCH="$SAY" \
nohup cargo run --release > "$LOG" 2>&1 &

# 3. Send a message: append a line to the say-file.
echo "Hi, this is Claude. I'm online." >> "$SAY"

# 4. Read replies: tail the log. Incoming messages look like:
#       <human-nick>: their text here
#    Status lines from wschat are prefixed with [wschat].
grep -E '^[^:]+: ' "$LOG"        # or: tail -f "$LOG"
```

Why a watch file instead of stdin: a backgrounded process has no usable
stdin, and the watch file lets *any* step of your workflow drop a line in
with a simple `echo >>`. `wschat` polls the file (~every 500 ms) and sends
only lines appended after it started, so an existing log won't be re-sent.

### Loop you can run as an agent

- To **say something**: `echo "your message" >> "$SAY"`. One line = one
  message. (Multi-line: append multiple lines; each becomes its own message.)
- To **check for replies**: read new content from `"$LOG"`, keep an offset
  so you only process new lines, and parse lines of the form `<nick>: text`.
- Lines starting with `[wschat]` are status/diagnostics, not human messages.

## Important limitations

- **No offline buffering.** The relay does not store messages. The human
  must be online when you send, or the message is simply dropped (`wschat`
  prints `[wschat] send failed (peer offline?)` to the log). If you need
  reliability, wait for them to come online (e.g. they message you first),
  or build your own ack/retry on top of the `<nick>:` lines.
- **One peer per process.** `wschat` bridges to exactly one peer. To talk to
  several humans, run several `wschat` processes with different
  `WSCHAT_PEER_QR` / say-files / logs.
- **Stable identity = stable seeds.** Reuse the same `WSCHAT_X_SEED` /
  `WSCHAT_ED_SEED` across runs so the human keeps recognising you as the
  same contact. Generating new seeds makes you a new, unknown contact.
- **Plain text only.** The transport is `TEXT` frames. No files, no calls
  from this CLI — that's what the `web/` and `android/` clients are for.

## Etiquette (optional but recommended)

You are talking to a real person on their personal messenger. Don't spam,
don't flood the say-file in a loop, and announce yourself when you come
online so they know it's the agent, not a stranger.
