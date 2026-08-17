import express from "express";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import type { ArticleBlock, MissingBlockCategory } from "../../shared/types.ts"
import cors from "cors";
import OAuth from "oauth-1.0a";
import crypto from "crypto";
import "dotenv/config";
import {
    fetchArticleHtml,
    getCachedImage,
} from "./urlUtils.js";

const oauth = new OAuth({
    consumer: {
        key: process.env.INSTAPAPER_CONSUMER_KEY!,
        secret: process.env.INSTAPAPER_CONSUMER_SECRET!,
    },
    signature_method: "HMAC-SHA1",
    hash_function(baseString, key) {
        return crypto
            .createHmac("sha1", key)
            .update(baseString)
            .digest("base64");
    },
});

const token = {
    key: process.env.INSTAPAPER_OAUTH_TOKEN!,
    secret: process.env.INSTAPAPER_OAUTH_SECRET!,
};

const app = express();
const PORT = 3000;
app.use(cors({
    origin: "http://localhost:5173"
}));
app.use(express.json());

app.get("/api/hello", (_req, res) => {
    res.json({ message: "Hello from Express" });
});

type ImageCandidate = {
    url: string;
    width?: number;
};

function blockKey(block: ArticleBlock): string {
    if (block.type === "image") {
        return `image:${block.src}`;
    }

    return `${block.type}:${block.text ?? ""}`;
}

function isLikelyTrackingImage(rawUrl: string): boolean {
    const lower = rawUrl.toLowerCase();

    return (
        lower.includes("facebook.com/tr") ||
        lower.includes("doubleclick.net") ||
        lower.includes("google-analytics.com") ||
        lower.includes("googletagmanager.com")
    );
}

function getImageCandidates(element: Element, pageUrl: string): ImageCandidate[] {
    const candidates: ImageCandidate[] = [];

    const addCandidate = (
        rawUrl: string | null | undefined,
        width?: number
    ) => {
        if (!rawUrl || rawUrl.startsWith("data:") || isLikelyTrackingImage(rawUrl)) {
            return;
        }

        try {
            const url = new URL(rawUrl, pageUrl);
            //url.search = "";

            candidates.push({
                url: url.href,
                ...(width !== undefined ? { width } : {}),
            });
        } catch {
            // Ignore malformed URLs
        }
    };

    // Parent <a>
    const href = element.closest("a")?.getAttribute("href");

    if (
        href &&
        /\.(jpe?g|png|webp|gif)(\?|$)/i.test(href)
    ) {
        addCandidate(href);
    }

    // Lazy-loaded source
    addCandidate(element.getAttribute("data-src"));

    // Normal source
    addCandidate(
        element.getAttribute("src"),
        Number(element.getAttribute("width")) || undefined
    );

    // srcset
    const srcset =
        element.getAttribute("srcset") ??
        element.getAttribute("data-srcset");

    if (srcset) {
        for (const entry of srcset.split(",")) {
            const parts = entry.trim().split(/\s+/);

            const rawUrl = parts[0];
            const descriptor = parts[1];

            let width: number | undefined;

            if (descriptor?.endsWith("w")) {
                width = Number(descriptor.slice(0, -1));
            }

            addCandidate(rawUrl, width);
        }
    }

    return candidates;
}

function getImageSrc(element: Element, pageUrl: string): string | null {
    const candidates =
        getImageCandidates(element, pageUrl);

    if (candidates.length === 0) {
        return null;
    }

    const withWidths = candidates.filter(
        candidate => candidate.width !== undefined
    );

    if (withWidths.length > 0) {
        withWidths.sort(
            (a, b) => b.width! - a.width!
        );

        return withWidths[0]!.url;
    }

    return candidates[0]!.url;
}

function sanitizeHtml(html: string) {
    return html.replace(/[\r\n\t]/g, "")
        .replace(/\\"/g, '"');
}

function isEmptyBlock(element: Element): boolean {
    const text = element.textContent
        ?.replace(/\u00A0/g, " ")
        .trim();

    return !text && element.querySelector("img") === null;
}

function normalizedText(element: Element): string {
    return element.textContent
        ?.replace(/\u00A0/g, " ")
        .replace(/\s+/g, " ")
        .trim() ?? "";
}

function extractBlocks(root: Element, pageUrl: string, isOriginal: boolean): ArticleBlock[] {
    root.querySelectorAll("span").forEach((span) => {
        span.replaceWith(...Array.from(span.childNodes));
    });

    const blocks: ArticleBlock[] = [];
    let sourceIndex = 0;

    function pushBlock(block: Omit<ArticleBlock, "sourceIndex">) {
        if (isOriginal) {
            blocks.push({
                ...block,
                sourceIndex,
            });

            sourceIndex++;
        } else {
            blocks.push(block);
        }
    }

    function walkHtml(element: Element) {
        const tag = element.tagName.toLowerCase();
        const tagsToSkip = ["script", "style", "nav", "form", "button", "iframe"];
        if (tagsToSkip.includes(tag)) {
            return;
        }
        if (tag === "img") {
            const link = element.closest("a");

            const src = getImageSrc(element, pageUrl);

            if (src) {
                pushBlock({
                    type: "image",
                    src: src,
                    alt: element.getAttribute("alt") ?? "",
                    inHeaderOrFooter: element.closest("header, footer") !== null
                });
            }
            return;
        }
        if (tag === "p") {
            const images = element.querySelectorAll(":scope > img");
            if (images.length === 1 && !element.textContent?.trim()) {
                walkHtml(images[0]!);
                return;
            }
            if (isEmptyBlock(element)) {
                return;
            }
            pushBlock({
                type: "paragraph",
                html: element.innerHTML,
                text: normalizedText(element),
            });
            return;
        }
        if (/^h[1-6]$/.test(tag)) {
            pushBlock({
                type: "heading",
                level: Number(tag[1]),
                html: sanitizeHtml(element.innerHTML),
                text: normalizedText(element),
            });
            return;
        }
        if (["ul", "ol", "blockquote"].includes(tag)) {
            pushBlock({
                type: tag,
                html: sanitizeHtml(element.innerHTML),
                text: normalizedText(element),
            });
            return;
        }
        if (element.matches("figcaption, .figure-caption, .figure-credit")) {
            if (isEmptyBlock(element)) {
                return;
            }

            pushBlock({
                type: "paragraph",
                html: element.innerHTML,
                text: normalizedText(element),
            });
        }
        for (const child of Array.from(element.children)) {
            walkHtml(child);
        }
    }

    walkHtml(root);
    return blocks;
}

function blocksToHtml(blocks: ArticleBlock[], title: string, includeHeader: boolean, thumbnailUrl: string | null) {
    const inner = blocks.map((block) => {
        if (block.type === "image") {
            return `<p><img src="${block.src}" alt="${block.alt ?? ""}"></p>`;
        }

        if (block.type === "heading") {
            return `<h${block.level}>${block.html ?? ""}</h${block.level}>`;
        }

        if (block.type === "paragraph") {
            return `<p>${block.html ?? ""}</p>`;
        }

        if (block.type === "ul" || block.type === "ol") {
            return `<${block.type}>${block.html ?? ""}</${block.type}>`;
        }

        if (block.type === "blockquote") {
            return `<blockquote>${block.html ?? ""}</blockquote>`;
        }

        return "";
    }).join("");

    const head = thumbnailUrl
        ? `
            <head>
                <meta property="og:image" content="${thumbnailUrl}">
            </head>
        `
        : "<head></head>";
    const header = includeHeader
        ? `<h1>${title}</h1>`
        : "";

    return `
        <!doctype html>
        <html>
            ${head}
            <body>
                <article>
                    ${header}
                    ${inner}
                </article>
            </body>
        </html>
    `;
}

function imageFilename(src: string): string {
    const url = new URL(src);
    return url.pathname.split("/").pop() ?? "";
}

function sameUnderlyingImage(a: string, b: string): boolean {
    return imageFilename(a) === imageFilename(b);
}

function classifyMissingBlock(block: ArticleBlock, articleTitle: string): "content" | "other" {
    // Images were classified using their DOM location
    if (block.type === "image") {
        return block.inHeaderOrFooter ? "other" : "content";
    }

    const text = block.text?.trim() ?? "";

    // Exact article title
    if (
        block.type === "heading" &&
        text.toLowerCase() === articleTitle.trim().toLowerCase()
    ) {
        return "other";
    }

    if (block.type === "heading" && text.length > 0) {
        return "content";
    }

    // Substantial textual content
    if (
        ["paragraph", "blockquote", "ul", "ol"].includes(block.type) &&
        text.length > 40
    ) {
        return "content";
    }

    return "other";
}

function isOriginalBlockCovered(
    originalBlock: ArticleBlock,
    articleContent: ArticleBlock[]
): boolean {
    // Images can keep using normal matching
    if (originalBlock.type === "image") {
        return articleContent.some(
            articleBlock =>
                blockKey(articleBlock) === blockKey(originalBlock)
        );
    }

    if (!originalBlock.text) {
        return false;
    }

    const matchingBlocks = articleContent
        .filter(
            articleBlock =>
                articleBlock.sourceIndex === originalBlock.sourceIndex &&
                articleBlock.text
        )
        .sort(
            (a, b) =>
                (a.readIndex ?? 0) -
                (b.readIndex ?? 0)
        );

    if (matchingBlocks.length === 0) {
        return false;
    }

    const combinedText = matchingBlocks
        .map(block => block.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();

    const originalText = originalBlock.text
        .replace(/\s+/g, " ")
        .trim();

    return combinedText === originalText;
}

function normalizedImageFilename(src: string, pageUrl?: string): string {
    const url = pageUrl
        ? new URL(src, pageUrl)
        : new URL(src);

    return decodeURIComponent(
        url.pathname.split("/").pop() ?? ""
    )
        .trim()
        .toLowerCase();
}

function resolveImageSrc(
    document: Document,
    imageSrc: string,
    pageUrl: string
): string | null {
    const targetFilename =
        normalizedImageFilename(imageSrc, pageUrl);

    const elements =
        document.querySelectorAll("[data-b-bg]");

    for (const element of elements) {
        const dataBg =
            element.getAttribute("data-b-bg");

        if (!dataBg) {
            continue;
        }

        try {
            const parsed = JSON.parse(dataBg);

            for (const value of Object.values(parsed)) {
                if (
                    typeof value !== "object" ||
                    value === null ||
                    !("src" in value) ||
                    typeof value.src !== "string"
                ) {
                    continue;
                }

                const candidateFilename =
                    normalizedImageFilename(
                        value.src,
                        pageUrl
                    );

                if (
                    candidateFilename === targetFilename
                ) {
                    return new URL(
                        value.src,
                        pageUrl
                    ).href;
                }
            }
        } catch {
            // ignore malformed data-b-bg
        }
    }

    return null;
}

function getThumbnailUrl(
    document: Document,
    pageUrl: string,
    originalContent: ArticleBlock[],
    articleContent: ArticleBlock[]
): string | null {
    const ogImage = document
        .querySelector('meta[property="og:image"]')
        ?.getAttribute("content");
    //console.log(`OGImage: ${ogImage}`);
    if (ogImage) {
        return new URL(ogImage, pageUrl).href;
    }

    const imageSrc = document
        .querySelector('link[rel="image_src"]')
        ?.getAttribute("href");
    //console.log(`imageSrc: ${imageSrc}`);
    if (imageSrc) {
        const imageSrc = document
            .querySelector('link[rel="image_src"]')
            ?.getAttribute("href");

        if (imageSrc) {
            const resolved = resolveImageSrc(
                document,
                imageSrc,
                pageUrl
            );

            if (resolved) {
                return resolved;
            }
        }
        const targetFilename = normalizedImageFilename(
            imageSrc!,
            pageUrl
        );

        console.log("image_src filename:", targetFilename);

        console.log(
            "original image filenames:",
            originalContent
                .filter(block => block.type === "image" && block.src)
                .map(block =>
                    normalizedImageFilename(block.src!)
                )
        );

        const match = originalContent.find(block => {
            if (block.type !== "image" || !block.src) {
                return false;
            }

            return (
                normalizedImageFilename(block.src) ===
                targetFilename
            );
        });

        if (match?.src) {
            return match.src;
        }
    }

    const twitterImage = document
        .querySelector('meta[name="twitter:image"]')
        ?.getAttribute("content");

    if (twitterImage) {
        return new URL(twitterImage, pageUrl).href;
    }

    return articleContent.find(
        block => block.type === "image" && block.src
    )?.src ?? null;
}

app.post("/api/extract", async (req, res) => {
    try {
        const url = req.body.url;

        const html = await fetchArticleHtml(url);

        const originalDom = new JSDOM(html, { url });
        const dom = new JSDOM(html, { url });

        const article = new Readability(dom.window.document).parse();
        const articleDOM = new JSDOM(article!.content!, { url });

        if (!article) {
            return res.status(422).json({
                error: "Could not extract article",
            });
        }

        const originalContent = extractBlocks(originalDom.window.document.body, url, true);
        const articleContent = extractBlocks(articleDOM.window.document.body, url, false);
        articleContent.forEach((block, index) => {
            block.readIndex = index;
        });
        const usedExactMatches = new Set<number>();

        for (const articleBlock of articleContent) {
            let exactMatch = originalContent.find(originalBlock =>
                blockKey(originalBlock) === blockKey(articleBlock) &&
                originalBlock.sourceIndex !== undefined &&
                !usedExactMatches.has(originalBlock.sourceIndex)
            );

            if (exactMatch?.sourceIndex !== undefined) {
                articleBlock.sourceIndex = exactMatch.sourceIndex;
                usedExactMatches.add(exactMatch.sourceIndex);
                continue;
            }

            // Your fallback for split blocks
            if (articleBlock.text) {
                const fallbackMatch = originalContent.find(originalBlock => {
                    if (
                        originalBlock.type !== articleBlock.type ||
                        !originalBlock.text
                    ) {
                        return false;
                    }

                    return originalBlock.text.includes(articleBlock.text!);
                });

                if (fallbackMatch?.sourceIndex !== undefined) {
                    articleBlock.sourceIndex = fallbackMatch.sourceIndex;
                }
            }
        }

        for (const articleBlock of articleContent) {
            if (
                articleBlock.type !== "image" ||
                !articleBlock.src
            ) {
                continue;
            }

            const match = originalContent.find(
                originalBlock =>
                    originalBlock.type === "image" &&
                    originalBlock.src &&
                    sameUnderlyingImage(
                        articleBlock.src!,
                        originalBlock.src
                    )
            );

            if (match?.src) {
                // Replace Readability thumbnail with the
                // better image from the original page
                articleBlock.src = match.src;

                if (match.sourceIndex !== undefined) {
                    articleBlock.sourceIndex = match.sourceIndex;
                }
            }
        }

        const missingContent = originalContent
            .filter(
                block =>
                    !isOriginalBlockCovered(
                        block,
                        articleContent
                    )
            )
            .map(block => ({
                ...block,
                category: classifyMissingBlock(
                    block,
                    article.title!
                ),
            }));

        const thumbnailUrl = getThumbnailUrl(
            originalDom.window.document,
            url,
            originalContent,
            articleContent
        );

        const readabilityTitle = article.title ?? "";

        const metadataTitle =
            originalDom.window.document
                .querySelector('meta[property="og:title"]')
                ?.getAttribute("content")
                ?.trim()
            ??
            originalDom.window.document.title.trim();

        res.json({
            url,
            readabilityTitle,
            metadataTitle,
            articleContent,
            missingContent,
            thumbnailUrl,
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Failed to extract article",
        });
    }
});

app.post("/api/send", async (req, res) => {
    try {
        const url = req.body.url as string;
        const title = req.body.title as string;
        const finalContent = req.body.finalContent as ArticleBlock[];
        const includeHeader = req.body.includeHeader as boolean;
        const thumbnailurl = req.body.thumbnailUrl as string | null;

        if (!url || !title || !Array.isArray(finalContent)) {
            return res.status(400).json({
                error: "Invalid request body",
            });
        }

        const html = blocksToHtml(finalContent, title, includeHeader, thumbnailurl);

        const instapaperUrl =
            "https://www.instapaper.com/api/1/bookmarks/add";

        const body = {
            url,
            title,
            resolve_final_url: "0",
            content: html,
        };

        const requestData = {
            url: instapaperUrl,
            method: "POST",
            data: body,
        };

        const authHeader =
            oauth.toHeader(
                oauth.authorize(requestData, token)
            );

        const formData = new URLSearchParams(body);

        const response = await fetch(instapaperUrl, {
            method: "POST",
            headers: {
                ...authHeader,
                "Content-Type":
                    "application/x-www-form-urlencoded",
            },
            body: formData.toString(),
        });

        const responseText = await response.text();

        if (!response.ok) {
            console.error(
                "Instapaper error:",
                response.status,
                responseText
            );

            return res.status(502).json({
                error: "Instapaper request failed",
                status: response.status,
                details: responseText,
            });
        }

        res.json({
            message: "Sent to Instapaper",
            response: responseText,
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Failed to send article to Instapaper",
        });
    }
});

app.get("/api/image", async (req, res) => {
    const imageUrl = req.query.url;

    if (typeof imageUrl !== "string") {
        return res.status(400).send("Missing image URL");
    }

    const cached = getCachedImage(imageUrl);

    if (cached) {
        // console.log(
        //     "Serving cached browser image:",
        //     imageUrl
        // );

        res.setHeader(
            "Content-Type",
            cached.contentType
        );

        return res.send(cached.data);
    }

    try {
        const parsedUrl = new URL(imageUrl);

        const response = await fetch(imageUrl, {
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
                    "AppleWebKit/537.36 (KHTML, like Gecko) " +
                    "Chrome/140.0.0.0 Safari/537.36",

                "Referer": `${parsedUrl.origin}/`,
            },
        });

        if (!response.ok) {
            console.error(
                "Image fetch failed:",
                response.status,
                imageUrl
            );

            return res
                .status(response.status)
                .send("Image fetch failed");
        }

        const contentType =
            response.headers.get("content-type");

        // console.log(
        //     "IMAGE PROXY:",
        //     response.status,
        //     contentType,
        //     imageUrl
        // );

        if (contentType) {
            res.setHeader(
                "Content-Type",
                contentType
            );
        }

        const buffer = Buffer.from(
            await response.arrayBuffer()
        );

        res.send(buffer);
    } catch (error) {
        console.error(error);
        res.status(500).send("Image proxy failed");
    }
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});