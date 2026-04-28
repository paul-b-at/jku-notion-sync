// src/auth.ts
import { chromium, type BrowserContext, type Page } from 'playwright'
import path from 'path'

const SESSION_DIR = path.resolve('.session')
const JKU_BASE = 'https://my.jku.at'

/**
 * Returns a Playwright browser context that's authenticated against JKU.
 * Reuses the persistent session if still valid, otherwise re-logs in.
 */
export async function getAuthedContext(): Promise<BrowserContext> {
	const ctx = await chromium.launchPersistentContext(SESSION_DIR, {
		headless: true,
	})

	const page = await ctx.newPage()
	const probeUrl = `${JKU_BASE}/api2/calendar/cockpit/moodle/calendar?fromDate=2026-01-01&toDate=2026-01-02`
	const res = await page.goto(probeUrl, { waitUntil: 'domcontentloaded' })

	const contentType = res?.headers()['content-type'] ?? ''
	const isJson = contentType.includes('json')

	if (!isJson) {
		console.log('🔑 Session expired or missing — logging in...')
		await login(page)
	} else {
		console.log('✅ Session still valid')
	}

	await page.close()
	return ctx
}

async function login(page: Page): Promise<void> {
	const user = Bun.env.JKU_USER
	const pass = Bun.env.JKU_PASS
	if (!user || !pass) throw new Error('JKU_USER / JKU_PASS missing in .env')

	await page.goto(JKU_BASE)
	await page.waitForLoadState('domcontentloaded')

	// Shibboleth login form — selectors may need adjusting after first run
	await page.fill('input[name="j_username"], #username', user)
	await page.fill('input[name="j_password"], #password', pass)
	await page.click('button[type="submit"], input[type="submit"]')

	// Wait until we're back on my.jku.at after the SSO bounce
	await page.waitForURL('**/my.jku.at/**', { timeout: 30_000 })
	console.log('✅ Logged in')
}