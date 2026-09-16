#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

function usage() {
  console.error(`Usage: node tools/write-relay-config.mjs --origin https://example.com [options]

Options:
  --keys <path>          server keys file (default: server/src/server_keys.rs)
  --out <path>           output JSON file (default: web/relay-config.json)
  --mailbox-xpub <hex>   optional mailbox X25519 public key
`)
}

function takeArg(args, name) {
  const idx = args.indexOf(name)
  if (idx === -1) return null
  const value = args[idx + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  args.splice(idx, 2)
  return value
}

function parseByteArray(source, name) {
  const re = new RegExp(`pub\\s+const\\s+${name}\\s*:\\s*\\[u8;\\s*32\\]\\s*=\\s*\\[([\\s\\S]*?)\\];`)
  const match = source.match(re)
  if (!match) throw new Error(`Could not find ${name} in server keys file`)
  const bytes = Array.from(match[1].matchAll(/0x[0-9a-fA-F]{1,2}|\b\d{1,3}\b/g), (m) => Number(m[0]))
  if (bytes.length !== 32 || bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) {
    throw new Error(`${name} must contain exactly 32 bytes`)
  }
  return Buffer.from(bytes).toString('hex')
}

function wsUrlFromOrigin(origin) {
  const u = new URL('/ws', origin)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  return u.toString()
}

const args = process.argv.slice(2)
const help = args.includes('-h') || args.includes('--help')
if (help) {
  usage()
  process.exit(0)
}

try {
  const origin = takeArg(args, '--origin')
  const keysPath = takeArg(args, '--keys') || 'server/src/server_keys.rs'
  const outPath = takeArg(args, '--out') || 'web/relay-config.json'
  const mailboxXpub = takeArg(args, '--mailbox-xpub')
  if (args.length) throw new Error(`Unknown arguments: ${args.join(' ')}`)
  if (!origin) throw new Error('--origin is required')
  if (mailboxXpub && !/^[0-9a-f]{64}$/i.test(mailboxXpub)) {
    throw new Error('--mailbox-xpub must be 64 hex characters')
  }

  const keys = await readFile(keysPath, 'utf8')
  const config = {
    url: wsUrlFromOrigin(origin),
    xpub: parseByteArray(keys, 'X25519_PUBLIC'),
    edpub: parseByteArray(keys, 'ED25519_PUBLIC'),
  }
  if (mailboxXpub) config.mailbox_xpub = mailboxXpub.toLowerCase()

  const resolvedOut = resolve(outPath)
  await mkdir(dirname(resolvedOut), { recursive: true })
  await writeFile(resolvedOut, `${JSON.stringify(config, null, 2)}\n`)
  console.log(`Wrote ${outPath}`)
} catch (err) {
  console.error(err.message)
  usage()
  process.exit(1)
}
