import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser, Page } from 'puppeteer';
import { logger } from './logger.js';

// Handle both ESM default and CJS interop
const puppeteer = (puppeteerExtra as any).default || puppeteerExtra;
const stealth =
  typeof StealthPlugin === 'function'
    ? StealthPlugin()
    : (StealthPlugin as any).default();
puppeteer.use(stealth);

/**
 * Singleton manager for a shared Puppeteer browser instance.
 * Used for Mailmeteor email finding — keeps one browser alive
 * to avoid cold-start overhead on every email lookup.
 */
export class BrowserManager {
  private static instance: BrowserManager | null = null;
  private browser: Browser | null = null;
  private launching = false;

  private constructor() {}

  public static getInstance(): BrowserManager {
    if (!BrowserManager.instance) {
      BrowserManager.instance = new BrowserManager();
    }
    return BrowserManager.instance;
  }

  /**
   * Get (or launch) the shared browser instance.
   */
  private async getBrowser(): Promise<Browser> {
    if (this.browser?.connected) {
      return this.browser;
    }

    // Prevent concurrent launches
    if (this.launching) {
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (!this.launching) {
            clearInterval(check);
            resolve();
          }
        }, 200);
      });
      if (this.browser?.connected) return this.browser;
    }

    this.launching = true;
    try {
      logger.info('[BrowserManager] Launching headless Chromium...');
      this.browser = (await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-extensions',
          '--window-size=1280,800',
        ],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      })) as Browser;

      this.browser.on('disconnected', () => {
        logger.warn('[BrowserManager] Browser disconnected unexpectedly.');
        this.browser = null;
      });

      logger.info('[BrowserManager] Chromium launched successfully.');
      return this.browser;
    } catch (err) {
      logger.error(err, '[BrowserManager] Failed to launch Chromium');
      throw err;
    } finally {
      this.launching = false;
    }
  }

  /**
   * Create a new page from the shared browser.
   * Caller is responsible for closing the page when done.
   */
  public async newPage(): Promise<Page> {
    const browser = await this.getBrowser();
    const page = await browser.newPage();

    // Set realistic viewport and user-agent
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    );

    return page;
  }

  /**
   * Gracefully close the shared browser.
   */
  public async close(): Promise<void> {
    if (this.browser) {
      try {
        await this.browser.close();
        logger.info('[BrowserManager] Chromium browser closed.');
      } catch (err) {
        logger.error(err, '[BrowserManager] Error closing browser');
      }
      this.browser = null;
    }
  }
}
