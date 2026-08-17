import { chromium } from "playwright";
import type { Page } from "playwright";

type CachedImage = {
    contentType: string;
    data: Buffer;
};

const imageCache = new Map<string, CachedImage>();

export function getCachedImage(
    url: string
): CachedImage | undefined {
    return imageCache.get(url);
}

async function cacheBrowserImages(page: Page) {
    page.on("response", async (response) => {
        const request = response.request();

        if (request.resourceType() !== "image") {
            return;
        }

        if (!response.ok()) {
            return;
        }

        try {
            const contentType =
                response.headers()["content-type"];

            if (!contentType?.startsWith("image/")) {
                return;
            }

            const data = await response.body();

            imageCache.set(response.url(), {
                contentType,
                data,
            });

            // console.log(
            //     "Cached browser image:",
            //     response.url()
            // );
        } catch (error) {
            console.error(
                "Could not cache image:",
                response.url(),
                error
            );
        }
    });
}

async function preparePageImages(page: Page) {
    // Scroll through the page so lazy-loaded images have a chance to load.
    await page.evaluate(async () => {
        await new Promise<void>((resolve) => {
            let totalHeight = 0;

            const timer = setInterval(() => {
                window.scrollBy(0, 800);
                totalHeight += 800;

                if (totalHeight >= document.body.scrollHeight) {
                    clearInterval(timer);
                    resolve();
                }
            }, 100);
        });
    });

    await page.waitForTimeout(500);

    // Copy the browser's actually-selected image URL into src.
    await page.evaluate(() => {
        for (const img of Array.from(document.images)) {
            if (img.currentSrc) {
                img.setAttribute("src", img.currentSrc);
            }

            img.removeAttribute("srcset");
            img.removeAttribute("data-srcset");
        }
    });
}

async function fetchWithManualBrowser(
    url: string
): Promise<string> {
    const browser = await chromium.launch({
        headless: false,
    });

    try {
        const page = await browser.newPage();

        // IMPORTANT: attach before goto()
        await cacheBrowserImages(page);

        await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: 30000,
        });

        await page.waitForFunction(() => {
            const title =
                document.title.toLowerCase();

            return (
                !title.includes("just a moment") &&
                document.body.innerText.length > 1000
            );
        }, {
            timeout: 0,
        });

        // Give lazy-loaded images a chance to load
        await preparePageImages(page);

        // Give response handlers a moment to finish
        await page.waitForTimeout(500);

        return await page.content();
    } finally {
        await browser.close();
    }
}

async function tryHeadlessBrowser(
    url: string
): Promise<string | null> {
    const browser = await chromium.launch({
        headless: true,
    });

    try {
        const page = await browser.newPage();

        await cacheBrowserImages(page);

        await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: 30000,
        });

        await preparePageImages(page);

        await page.waitForTimeout(500);

        return await page.content();
    } catch (error) {
        console.error(
            "Headless Playwright failed:",
            error
        );

        return null;
    } finally {
        await browser.close();
    }
}

function isChallengeHtml(html: string): boolean {
    const lower = html.toLowerCase();

    return (
        lower.includes("<title>just a moment...</title>") ||
        lower.includes("cf-chl-") ||
        lower.includes("challenge-platform")
    );
}

function isBlocked(
    status: number,
    html: string
): boolean {
    return (
        status === 403 ||
        status === 429 ||
        isChallengeHtml(html)
    );
}

export async function fetchArticleHtml(url: string): Promise<string> {
    // 1. Normal fetch
    const response = await fetch(url);
    const html = await response.text();

    if (!isBlocked(response.status, html)) {
        //console.log("Using normal fetch");
        return html;
    }

    //console.log("Normal fetch blocked");

    // 2. Headless Playwright
    const headlessHtml = await tryHeadlessBrowser(url);

    if (headlessHtml && !isChallengeHtml(headlessHtml)) {
        //console.log("Using headless Playwright");
        return headlessHtml;
    }

    //console.log("Headless Playwright blocked");

    // 3. Headed Playwright
    //console.log("Opening browser for manual verification...");

    return await fetchWithManualBrowser(url);
}