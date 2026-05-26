import { nextTestSetup } from 'e2e-utils'
import { retry } from 'next-test-utils'
import type * as Playwright from 'playwright'

// Verifies the behavior introduced in https://github.com/vercel/next.js/pull/94062:
// the App Router should register a single HMR chunk list per page entrypoint,
// even when the page contains RSC client references (e.g. lazily-imported
// client components). Previously each chunk_group call produced its own
// Dynamic EcmascriptDevChunkList, resulting in one subscription per client
// component group.
describe('hmr-dynamic-component chunk list subscriptions', () => {
  const { next, isTurbopack, isNextDev } = nextTestSetup({
    files: __dirname,
  })

  if (!isTurbopack || !isNextDev) {
    it('skipped on non-Turbopack or non-dev environments', () => {})
    return
  }

  it('registers exactly one HMR chunk list subscription for the page entrypoint', async () => {
    const sentSubscribes: Array<{ type: string; path: string }> = []

    const browser = await next.browser('/', {
      beforePageLoad(page: Playwright.Page) {
        page.on('websocket', (ws) => {
          // Only inspect the Next.js / Turbopack HMR websocket. Other
          // websockets (e.g. devtools) should be ignored.
          if (!ws.url().includes('/_next/hmr')) {
            return
          }
          ws.on('framesent', (frame) => {
            const payload =
              typeof frame.payload === 'string'
                ? frame.payload
                : frame.payload.toString('utf8')
            try {
              const parsed = JSON.parse(payload)
              if (
                parsed?.type === 'turbopack-subscribe' &&
                typeof parsed?.path === 'string'
              ) {
                sentSubscribes.push({ type: parsed.type, path: parsed.path })
              }
            } catch {
              // Non-JSON frames are unrelated; ignore.
            }
          })
        })
      },
    })

    // Wait for the page to fully boot and for HMR subscriptions to settle.
    await retry(async () => {
      const div = await browser.elementByCss('#dynamic-component')
      expect(await div.text()).toContain('Dynamic Component')
    })

    // Give the client a moment to flush any deferred chunk-list registrations.
    // Each `turbopack-subscribe` frame corresponds to one `registerChunkList`
    // call in the browser runtime; the same chunk list path may be subscribed
    // to more than once (e.g. on socket reconnect), so we assert on the number
    // of *distinct* chunk list paths. With the fix in place there should be
    // exactly one chunk list path — the page entrypoint — and no extra Dynamic
    // chunk lists for RSC client references.
    await retry(async () => {
      const chunkListPaths = new Set(
        sentSubscribes.filter((m) => m.path.endsWith('.js')).map((m) => m.path)
      )
      expect(chunkListPaths.size).toBeGreaterThan(0)
      expect(chunkListPaths.size).toBe(1)
    })
  })
})
