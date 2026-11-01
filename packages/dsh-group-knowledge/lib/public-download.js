import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'

// Resolve and pin the actual connection address, including every redirect.
export function isPublicAddress(address) {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number)
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 2))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113))
  }
  if (isIP(address) !== 6) return false
  const [first, second] = address.toLowerCase().split(':').map(x => parseInt(x || '0', 16))
  return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 &&
    !(first === 0x2001 && (second < 0x200 || second === 0xdb8))
}

export async function publicTarget(value, resolve = dns.lookup) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('URL_NOT_ALLOWED')
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await resolve(hostname, { all: true, verbatim: true })
  if (!addresses.length || addresses.some(x => !isPublicAddress(x.address))) throw new Error('NON_PUBLIC_ADDRESS')
  return { url, address: addresses[0] }
}

function requestOnce(url, { address, signal, maxBytes, headers }) {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'GET', signal, headers,
      lookup: (_host, options, callback) => options?.all
        ? callback(null, [address]) : callback(null, address.address, address.family),
    }, response => {
      const location = response.headers.location
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && location) {
        response.destroy(); resolve({ status: response.statusCode, location }); return
      }
      const fail = error => { response.destroy(); reject(error) }
      if (response.statusCode < 200 || response.statusCode >= 300) { fail(new Error('HTTP_' + response.statusCode)); return }
      if (Number(response.headers['content-length']) > maxBytes) { fail(new Error('RESPONSE_TOO_LARGE')); return }
      let size = 0
      const chunks = []
      response.on('data', chunk => {
        size += chunk.length
        if (size > maxBytes) fail(new Error('RESPONSE_TOO_LARGE'))
        else chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('aborted', () => reject(new Error('RESPONSE_ABORTED')))
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) }))
    })
    request.on('error', reject)
    request.end()
  })
}

let active = 0
const waiting = []
export async function publicDownload(value, { maxBytes = 500_000, timeoutMs = 15000, resolve = dns.lookup, transport = requestOnce } = {}) {
  if (active >= 3) {
    if (waiting.length >= 32) throw new Error('DOWNLOAD_QUEUE_FULL')
    await new Promise(ready => waiting.push(ready))
  } else active += 1
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('DOWNLOAD_TIMEOUT')), timeoutMs)
  // DNS lookup cannot be interrupted; stop waiting and never start a request after the deadline.
  let abortHandler
  const aborted = new Promise((_, reject) => {
    abortHandler = () => reject(controller.signal.reason)
    controller.signal.addEventListener('abort', abortHandler, { once: true })
  })
  try {
    return await Promise.race([(async () => {
      let current = value
      for (let redirects = 0; redirects <= 3; redirects += 1) {
        const { url, address } = await publicTarget(current, resolve)
        controller.signal.throwIfAborted()
        const result = await transport(url, { address, signal: controller.signal, maxBytes, headers: { 'user-agent': 'dafeiyu/1.0', 'accept-encoding': 'identity' } })
        controller.signal.throwIfAborted()
        if (!result.location) {
          if (!result.bytes || result.bytes.length > maxBytes) throw new Error('RESPONSE_TOO_LARGE')
          return result
        }
        current = new URL(result.location, url).href
      }
      throw new Error('TOO_MANY_REDIRECTS')
    })(), aborted])
  } finally {
    clearTimeout(timer)
    controller.signal.removeEventListener('abort', abortHandler)
    const next = waiting.shift()
    if (next) next()
    else active -= 1
  }
}
