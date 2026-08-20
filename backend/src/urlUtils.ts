import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { chromium } from "playwright";
import type { Page } from "playwright";

type CachedImage = {
    contentType: string;
    data: Buffer;
};

type ImageNameMap = Record<string, string>;

const imageCache = new Map<string, CachedImage>();

export function cacheImage(
    url: string,
    contentType: string,
    data: Buffer
) {
    const cachedImage: CachedImage = {
        contentType,
        data,
    };

    imageCache.set(
        url,
        cachedImage
    );

    imageCache.set(
        imageCacheKey(url),
        cachedImage
    );
}

async function loadImageNameMap(
    directory: string
): Promise<ImageNameMap> {
    const mapPath =
        path.join(directory, "images.json");

    try {
        const contents =
            await fs.readFile(
                mapPath,
                "utf8"
            );

        return JSON.parse(contents);
    } catch {
        return {};
    }
}

async function saveImageNameMap(
    directory: string,
    map: ImageNameMap
) {
    const mapPath =
        path.join(directory, "images.json");

    await fs.writeFile(
        mapPath,
        JSON.stringify(
            map,
            null,
            2
        ),
        "utf8"
    );
}

async function getMappedFilename(
    directory: string,
    originalUrl: string,
    originalFilename: string
): Promise<{
    filename: string;
    map: ImageNameMap;
}> {
    const map =
        await loadImageNameMap(directory);

    /*
     * Reuse the exact same filename
     * if we've already seen this URL.
     */
    const existing =
        map[originalUrl];

    if (existing) {
        return {
            filename: existing,
            map,
        };
    }

    const extension =
        path.extname(
            originalFilename
        );

    const basename =
        path.basename(
            originalFilename,
            extension
        );

    let filename =
        originalFilename;

    let counter = 2;

    const usedNames =
        new Set(
            Object.values(map)
        );

    while (
        usedNames.has(filename) ||
        await fileExists(
            path.join(
                directory,
                filename
            )
        )
    ) {
        filename =
            `${basename}-${counter}${extension}`;

        counter++;
    }

    map[originalUrl] =
        filename;

    return {
        filename,
        map,
    };
}

async function getWallabagImageInfo(
    originalUrl: string,
    articleUrl: string
) {
    const imageDir =
        process.env.WALLABAG_IMAGE_DIR!;

    const publicUrl =
        process.env.WALLABAG_PUBLIC_URL!;

    const articleSubdir =
        getArticleImageSubdir(
            articleUrl
        );

    const parsedUrl =
        new URL(originalUrl);

    let originalFilename =
        decodeURIComponent(
            parsedUrl.pathname
                .split("/")
                .pop() ?? ""
        );

    if (!originalFilename) {
        originalFilename =
            "image.jpg";
    }

    originalFilename =
        originalFilename.replace(
            /[^a-zA-Z0-9._-]/g,
            "_"
        );

    const destinationDir =
        path.join(
            imageDir,
            articleSubdir
        );

    /*
     * Make sure the per-article directory
     * exists before reading/writing images.json.
     */
    await fs.mkdir(
        destinationDir,
        {
            recursive: true,
        }
    );

    /*
     * This is where duplicate filenames are
     * resolved:
     *
     * image.jpg
     * image-2.jpg
     * image-3.jpg
     *
     * Existing URLs reuse their old mapping.
     */
    const {
        filename,
        map,
    } = await getMappedFilename(
        destinationDir,
        originalUrl,
        originalFilename
    );

    /*
     * Persist the URL -> filename mapping.
     */
    await saveImageNameMap(
        destinationDir,
        map
    );

    const destination =
        path.join(
            destinationDir,
            filename
        );

    const wallabagUrl =
        `${publicUrl.replace(/\/$/, "")}` +
        `/assets/images/` +
        `${encodeURIComponent(articleSubdir)}/` +
        `${encodeURIComponent(filename)}`;

    return {
        parsedUrl,
        destinationDir,
        destination,
        wallabagUrl,
        filename,
    };
}

async function fileExists(
    filePath: string
): Promise<boolean> {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

function imageCacheKey(
    urlString: string
): string {
    try {
        const url =
            new URL(urlString);

        const originalFilename =
            decodeURIComponent(
                url.pathname
                    .split("/")
                    .pop() ?? ""
            );

        const normalizedFilename =
            originalFilename
                .replace(
                    /-\d+x\d+(?=\.[^.]+$)/,
                    ""
                )
                .replace(
                    /-scaled(?=\.[^.]+$)/,
                    ""
                );

        if (
            normalizedFilename !==
            originalFilename
        ) {
            const normalizedPath =
                url.pathname.replace(
                    originalFilename,
                    normalizedFilename
                );

            return (
                url.origin +
                normalizedPath
            ).toLowerCase();
        }

        return url.href.toLowerCase();
    } catch {
        return urlString.toLowerCase();
    }
}

export function getCachedImage(
    url: string
): CachedImage | undefined {
    return (
        imageCache.get(url) ??
        imageCache.get(imageCacheKey(url))
    );
}

function cacheBrowserImages(page: Page) {
    const pending = new Set<Promise<void>>();

    let blockedImageCount = 0;

    page.on("response", (response) => {
        const request = response.request();

        if (request.resourceType() !== "image") {
            return;
        }

        // Track sites that start refusing image requests.
        if (
            response.status() === 403 ||
            response.status() === 429
        ) {
            blockedImageCount++;

            console.log(
                "Blocked image:",
                response.status(),
                response.url()
            );

            return;
        }

        if (!response.ok()) {
            return;
        }

        const task = (async () => {
            try {
                const contentType =
                    response.headers()["content-type"];

                if (!contentType?.startsWith("image/")) {
                    return;
                }

                const data = await response.body();

                const cachedImage: CachedImage = {
                    contentType,
                    data,
                };

                imageCache.set(
                    response.url(),
                    cachedImage
                );

                imageCache.set(
                    imageCacheKey(response.url()),
                    cachedImage
                );

                console.log(
                    "Cached browser image:",
                    response.url(),
                    "normalized:",
                    imageCacheKey(response.url())
                );
            } catch (error) {
                console.error(
                    "Could not cache image:",
                    response.url(),
                    error
                );
            }
        })();

        pending.add(task);

        task.finally(() => {
            pending.delete(task);
        });
    });

    async function waitForImageCache() {
        const cacheFinished = async () => {
            while (pending.size > 0) {
                await Promise.all([...pending]);
            }
        };

        // Never let image caching hold the browser open forever.
        await Promise.race([
            cacheFinished(),

            new Promise<void>((resolve) => {
                setTimeout(resolve, 5000);
            }),
        ]);
    }

    function getBlockedImageCount() {
        return blockedImageCount;
    }

    return {
        waitForImageCache,
        getBlockedImageCount,
    };
}

async function preparePageImages(
    page: Page,
    getBlockedImageCount: () => number,
    stopOnBlockedImages = true
) {
    /*
        Scroll similarly to how you were doing before,
        but stop if the site clearly starts refusing
        image requests.
    */
    for (let i = 0; i < 40; i++) {
        if (
            stopOnBlockedImages &&
            getBlockedImageCount() >= 5
        ) {
            console.log(
                "Too many blocked image requests; " +
                "stopping lazy-image loading attempts"
            );

            break;
        }

        const reachedBottom = await page.evaluate(() => {
            window.scrollBy(
                0,
                Math.floor(window.innerHeight * 0.6)
            );

            return (
                window.scrollY +
                window.innerHeight >=
                document.body.scrollHeight - 100
            );
        });

        // Enough time for IntersectionObserver /
        // lazy loading to notice the new viewport.
        await page.waitForTimeout(350);

        if (reachedBottom) {
            break;
        }
    }

    /*
        Only give final requests a short window.
        Don't sit around waiting for blocked images.
    */
    if (
        !stopOnBlockedImages ||
        getBlockedImageCount() < 5
    ) {
        await page.waitForTimeout(1000);
    }

    /*
        Preserve whichever image URL the browser actually
        selected from srcset.
    */
    await page.evaluate(() => {
        for (const img of Array.from(document.images)) {
            if (img.currentSrc) {
                img.setAttribute(
                    "src",
                    img.currentSrc
                );
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

        const {
            waitForImageCache,
            getBlockedImageCount,
        } = cacheBrowserImages(page);

        await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: 30000,
        });

        // Wait indefinitely for manual challenge completion.
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

        await preparePageImages(
            page,
            getBlockedImageCount
        );

        /*
            Let successful image response bodies finish
            entering the cache, but only for a bounded
            amount of time.
        */
        await waitForImageCache();

        console.log(
            "Finished browser image caching"
        );

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

        const {
            waitForImageCache,
            getBlockedImageCount,
        } = cacheBrowserImages(page);

        // Don't call cacheBrowserImages(page) again here.

        await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: 30000,
        });

        /*
            If this is still a Cloudflare challenge,
            there's no reason to spend time scrolling it.
        */
        const currentHtml = await page.content();

        if (isChallengeHtml(currentHtml)) {
            return currentHtml;
        }

        await preparePageImages(
            page,
            getBlockedImageCount
        );

        await waitForImageCache();

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
        lower.includes(
            "<title>just a moment...</title>"
        ) ||
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

export async function fetchArticleHtml(
    url: string
): Promise<string> {
    // 1. Normal fetch
    const response = await fetch(url);
    const html = await response.text();

    if (!isBlocked(response.status, html)) {
        return html;
    }

    // 2. Headless Playwright
    const headlessHtml =
        await tryHeadlessBrowser(url);

    if (
        headlessHtml &&
        !isChallengeHtml(headlessHtml)
    ) {
        return headlessHtml;
    }

    // 3. Headed Playwright
    return await fetchWithManualBrowser(url);
}


function getExtension(contentType: string) {
    const clean = contentType.split(";")[0]!.trim().toLowerCase();

    switch (clean) {
        case "image/png":
            return ".png";
        case "image/webp":
            return ".webp";
        case "image/gif":
            return ".gif";
        case "image/svg+xml":
            return ".svg";
        default:
            return ".jpg";
    }
}

function getArticleImageSubdir(articleUrl: string): string {
    const url = new URL(articleUrl);

    const slug =
        url.pathname
            .split("/")
            .filter(Boolean)
            .pop() ?? "article";

    return slug.replace(
        /[^a-zA-Z0-9._-]/g,
        "_"
    );
}

export async function saveImageForWallabag(
    originalUrl: string,
    articleUrl: string
): Promise<{
    url: string;
    saved: boolean;
}> {
    const {
        parsedUrl,
        destinationDir,
        destination,
        wallabagUrl,
    } = await getWallabagImageInfo(
        originalUrl,
        articleUrl
    );

    /*
     * Fastest path:
     * we've already saved this image previously.
     */
    if (await fileExists(destination)) {
        console.log(
            "Wallabag image already exists:",
            destination
        );

        return {
            url: wallabagUrl,
            saved: true,
        };
    }

    /*
     * Second fastest:
     * Playwright already captured this image.
     */
    const cached =
        getCachedImage(originalUrl);

    if (cached) {
        await fs.mkdir(
            destinationDir,
            {
                recursive: true,
            }
        );

        await fs.writeFile(
            destination,
            cached.data
        );

        console.log(
            "Saved cached Wallabag image:",
            destination
        );

        return {
            url: wallabagUrl,
            saved: true,
        };
    }

    /*
     * Try a normal HTTP request before resorting
     * to Chromium.
     */
    try {
        const response =
            await fetch(
                originalUrl,
                {
                    headers: {
                        "User-Agent":
                            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
                            "AppleWebKit/537.36 (KHTML, like Gecko) " +
                            "Chrome/140.0.0.0 Safari/537.36",

                        "Referer":
                            `${parsedUrl.origin}/`,
                    },
                }
            );

        if (response.ok) {
            const data =
                Buffer.from(
                    await response.arrayBuffer()
                );

            await fs.mkdir(
                destinationDir,
                {
                    recursive: true,
                }
            );

            await fs.writeFile(
                destination,
                data
            );

            console.log(
                "Downloaded Wallabag image:",
                destination
            );

            return {
                url: wallabagUrl,
                saved: true,
            };
        }

        console.log(
            "Direct image fetch failed:",
            response.status,
            originalUrl
        );
    } catch (error) {
        console.log(
            "Direct image fetch failed:",
            originalUrl,
            error
        );
    }

    /*
     * Important:
     * DON'T harvest here.
     *
     * We return saved:false so the caller can decide
     * to harvest the entire article once instead of
     * opening Chromium once per image.
     */
    return {
        url: wallabagUrl,
        saved: false,
    };
}

export async function harvestArticleImages(
    articleUrl: string
) {
    // 1. Try headless first
    const headlessBrowser = await chromium.launch({
        headless: true,
    });

    try {
        const page = await headlessBrowser.newPage();

        const {
            waitForImageCache,
            getBlockedImageCount,
        } = cacheBrowserImages(page);

        await page.goto(articleUrl, {
            waitUntil: "domcontentloaded",
            timeout: 30000,
        });

        const html = await page.content();

        if (!isChallengeHtml(html)) {
            await preparePageImages(
                page,
                getBlockedImageCount,
                false
            );

            await waitForImageCache();

            console.log(
                "Harvested article images headlessly"
            );

            return;
        }

        console.log(
            "Headless image harvest hit challenge"
        );
    } catch (error) {
        console.error(
            "Headless image harvest failed:",
            error
        );
    } finally {
        await headlessBrowser.close();
    }

    // 2. Only open visible browser if needed
    console.log(
        "Opening headed browser for image harvest"
    );

    const headedBrowser = await chromium.launch({
        headless: false,
    });

    try {
        const page = await headedBrowser.newPage();

        const {
            waitForImageCache,
            getBlockedImageCount,
        } = cacheBrowserImages(page);

        await page.goto(articleUrl, {
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

        await preparePageImages(
            page,
            getBlockedImageCount,
            false
        );

        await waitForImageCache();

        console.log(
            "Harvested article images in headed browser"
        );
    } finally {
        await headedBrowser.close();
    }
}

export async function prepareWallabagImages(
    imageUrls: string[],
    articleUrl: string
): Promise<Map<string, string>> {
    const results =
        new Map<string, string>();

    const stillMissing: string[] = [];

    /*
     * First pass:
     * disk → cache → direct fetch
     */
    for (const imageUrl of imageUrls) {
        const result =
            await saveImageForWallabag(
                imageUrl,
                articleUrl
            );

        results.set(
            imageUrl,
            result.url
        );

        if (!result.saved) {
            stillMissing.push(
                imageUrl
            );
        }
    }

    /*
     * Nothing difficult?
     *
     * We're done. No Chromium.
     */
    if (stillMissing.length === 0) {
        console.log(
            "All Wallabag images ready; skipping browser harvest"
        );

        return results;
    }

    console.log(
        `${stillMissing.length} images still missing; ` +
        "starting browser harvest"
    );

    /*
     * Only now pay the Playwright cost.
     */
    await harvestArticleImages(
        articleUrl
    );

    /*
     * Second pass.
     *
     * Don't direct-fetch everything again.
     * We're primarily looking for newly harvested
     * cache entries.
     */
    for (const imageUrl of stillMissing) {
        const {
    destinationDir,
    destination,
    wallabagUrl,
} = await getWallabagImageInfo(
    imageUrl,
    articleUrl
);

        /*
         * Something may already have appeared while
         * harvesting.
         */
        if (await fileExists(destination)) {
            results.set(
                imageUrl,
                wallabagUrl
            );

            continue;
        }

        const cached =
            getCachedImage(imageUrl);

        if (cached) {
            await fs.mkdir(
                destinationDir,
                {
                    recursive: true,
                }
            );

            await fs.writeFile(
                destination,
                cached.data
            );

            console.log(
                "Saved harvested Wallabag image:",
                destination
            );
        } else {
            console.warn(
                "Image still unavailable after harvest."
            );

            console.warn(
                "Manual fallback:",
                destination
            );
        }

        /*
         * Still return the predictable local URL.
         * You can manually place the missing image later.
         */
        results.set(
            imageUrl,
            wallabagUrl
        );
    }

    return results;
}