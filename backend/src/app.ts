import express from "express";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import type { ArticleBlock, MissingBlockCategory } from "../../shared/types.ts"
import cors from "cors";
import OAuth from "oauth-1.0a";
import crypto from "crypto";
import "dotenv/config";
import {
    cacheImage,
    fetchArticleHtml,
    getCachedImage,
    harvestArticleImages,
    prepareWallabagImages,
    saveImageForWallabag,
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

let wallabagAccessToken: string | null = null;
let wallabagRefreshToken: string | null = null;
let wallabagTokenExpiresAt = 0;

async function wallabagAuth() {
    const baseUrl = process.env.WALLABAG_URL
    const body = new URLSearchParams({
        grant_type: "password",
        client_id: process.env.WALLABAG_CLIENT_ID!,
        client_secret: process.env.WALLABAG_CLIENT_SECRET!,
        username: process.env.WALLABAG_USERNAME!,
        password: process.env.WALLABAG_PASSWORD!,
    });
    const response = await fetch(
        `http://192.168.0.199:8080/oauth/v2/token`,
        {
            method: "POST",
            headers: {
                "Content-Type":
                    "application/x-www-form-urlencoded",
            },
            body: body.toString(),
        }
    );
    if (!response.ok) {
        throw new Error(
            `Wallabag token request failed: ${response.status}`
        );
    }

    const responseBody = await response.json();

    wallabagAccessToken = responseBody.access_token;
    wallabagRefreshToken = responseBody.refresh_token;
}

const app = express();
const PORT = 3000;
app.use(cors({
    origin: true,
}));
app.use(express.json({
    limit: "10mb",
}));

app.get("/api/hello", (_req, res) => {
    res.json({ message: "Hello from Express" });
});

type ImageCandidate = {
    url: string;
    width?: number;
};

type PendingArticle = {
    createdAt: number;
    article: any;
};

const pendingArticles =
    new Map<string, PendingArticle>();

setInterval(() => {
    const cutoff =
        Date.now() - 10 * 60 * 1000;

    for (
        const [id, item]
        of pendingArticles
    ) {
        if (item.createdAt < cutoff) {
            pendingArticles.delete(id);
        }
    }
}, 60_000);

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
    let readIndex = 0;

    function pushBlock(block: Omit<ArticleBlock, "sourceIndex">) {
        if (isOriginal) {
            blocks.push({
                ...block,
                sourceIndex,
                id: `original-${sourceIndex}`
            });

            sourceIndex++;
        } else {
            blocks.push({
                ...block,
                readIndex,
                id: `readability-${readIndex}`
            });

            readIndex++;
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
        if (tag === "figure") {
            /*
             * Process figure contents explicitly and
             * in DOM order.
             *
             * Images become image blocks and captions
             * become paragraph blocks.
             */
            for (
                const child
                of Array.from(element.children)
            ) {
                const childTag =
                    child.tagName
                        .toLowerCase();

                if (
                    childTag ===
                    "figcaption"
                ) {
                    if (
                        !isEmptyBlock(
                            child
                        )
                    ) {
                        pushBlock({
                            type:
                                "paragraph",

                            html:
                                sanitizeHtml(
                                    child.innerHTML
                                ),

                            text:
                                normalizedText(
                                    child
                                ),
                        });
                    }

                    continue;
                }

                /*
                 * Patreon wraps the actual <img>
                 * in one or more <div>s, so recurse
                 * through non-caption children.
                 */
                walkHtml(
                    child
                );
            }

            return;
        }
        if (tag === "p") {
            if (isEmptyBlock(element)) {
                return;
            }

            let htmlBuffer = "";

            const flushHtmlBuffer = () => {
                const temp =
                    element.ownerDocument.createElement(
                        "div"
                    );

                temp.innerHTML =
                    htmlBuffer.trim();

                /*
                 * Remove whitespace-only text nodes
                 * and <br> elements from the start.
                 */
                while (temp.firstChild) {
                    const first =
                        temp.firstChild;

                    if (
                        first.nodeType ===
                        first.TEXT_NODE &&
                        !first.textContent?.trim()
                    ) {
                        first.remove();
                        continue;
                    }

                    if (
                        first.nodeType ===
                        first.ELEMENT_NODE &&
                        (first as Element)
                            .tagName
                            .toLowerCase() === "br"
                    ) {
                        first.remove();
                        continue;
                    }

                    break;
                }

                /*
                 * Do the same at the end.
                 */
                while (temp.lastChild) {
                    const last =
                        temp.lastChild;

                    if (
                        last.nodeType ===
                        last.TEXT_NODE &&
                        !last.textContent?.trim()
                    ) {
                        last.remove();
                        continue;
                    }

                    if (
                        last.nodeType ===
                        last.ELEMENT_NODE &&
                        (last as Element)
                            .tagName
                            .toLowerCase() === "br"
                    ) {
                        last.remove();
                        continue;
                    }

                    break;
                }

                const html =
                    temp.innerHTML.trim();

                if (!html) {
                    htmlBuffer = "";
                    return;
                }

                const text =
                    normalizedText(temp);

                if (!text) {
                    htmlBuffer = "";
                    return;
                }

                pushBlock({
                    type: "paragraph",
                    html: sanitizeHtml(html),
                    text,
                });

                htmlBuffer = "";
            };

            const serializeAttributes = (
                node: Element
            ) =>
                Array.from(node.attributes)
                    .map(
                        attr =>
                            ` ${attr.name}="${attr.value}"`
                    )
                    .join("");

            const inlineTags = new Set([
                "a",
                "strong",
                "b",
                "em",
                "i",
                "span",
                "small",
                "mark",
                "u",
                "s",
                "sup",
                "sub",
                "code",
            ]);

            /*
             * Convert one DOM node into a sequence of:
             *
             *   HTML fragments
             *   or
             *   image nodes
             *
             * This lets us preserve inline formatting while
             * breaking images out into independent blocks.
             */
            type SplitPart =
                | {
                    type: "html";
                    html: string;
                }
                | {
                    type: "image";
                    element: Element;
                };

            const splitNode = (
                node: Node
            ): SplitPart[] => {
                /*
                 * Plain text.
                 */
                if (
                    node.nodeType ===
                    node.TEXT_NODE
                ) {
                    const text =
                        node.textContent ?? "";

                    return text
                        ? [
                            {
                                type: "html",
                                html: text,
                            },
                        ]
                        : [];
                }

                /*
                 * Ignore comments/etc.
                 */
                if (
                    node.nodeType !==
                    node.ELEMENT_NODE
                ) {
                    return [];
                }

                const elementNode =
                    node as Element;

                const tagName =
                    elementNode.tagName.toLowerCase();

                /*
                 * Images always become their own block.
                 */
                if (tagName === "img") {
                    return [
                        {
                            type: "image",
                            element:
                                elementNode,
                        },
                    ];
                }

                /*
                 * If this element contains no image,
                 * preserve it exactly as HTML.
                 */
                if (
                    !elementNode.querySelector(
                        "img"
                    )
                ) {
                    return [
                        {
                            type: "html",
                            html:
                                elementNode.outerHTML,
                        },
                    ];
                }

                /*
                 * If it contains an image and is an
                 * inline wrapper, recursively split it
                 * while preserving that wrapper around
                 * each text fragment.
                 */
                if (
                    inlineTags.has(
                        tagName
                    )
                ) {
                    const attributes =
                        serializeAttributes(
                            elementNode
                        );

                    const childParts =
                        Array.from(
                            elementNode.childNodes
                        ).flatMap(
                            child =>
                                splitNode(child)
                        );

                    const wrappedParts:
                        SplitPart[] = [];

                    for (
                        const part
                        of childParts
                    ) {
                        if (
                            part.type ===
                            "image"
                        ) {
                            wrappedParts.push(
                                part
                            );

                            continue;
                        }

                        if (
                            !part.html.trim()
                        ) {
                            continue;
                        }

                        wrappedParts.push({
                            type: "html",
                            html:
                                `<${tagName}${attributes}>` +
                                part.html +
                                `</${tagName}>`,
                        });
                    }

                    return wrappedParts;
                }

                /*
                 * Non-inline container containing images:
                 * recurse into its children.
                 *
                 * This handles wrappers like div/figure/etc.
                 */
                return Array.from(
                    elementNode.childNodes
                ).flatMap(
                    child =>
                        splitNode(child)
                );
            };

            const parts =
                Array.from(
                    element.childNodes
                ).flatMap(
                    node =>
                        splitNode(node)
                );

            for (
                const part
                of parts
            ) {
                if (
                    part.type ===
                    "image"
                ) {
                    flushHtmlBuffer();

                    walkHtml(
                        part.element
                    );

                    continue;
                }

                htmlBuffer +=
                    part.html;
            }

            flushHtmlBuffer();

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
        if (["ul", "ol", "blockquote", "table"].includes(tag)) {
            pushBlock({
                type: tag,
                html: sanitizeHtml(element.innerHTML),
                text: normalizedText(element),
            });
            return;
        }
        if (
            element.matches(
                `
        figcaption,
        .figure-caption,
        .figure-credit,
        .wp-caption-text
        `
            )
        ) {
            if (
                isEmptyBlock(
                    element
                )
            ) {
                return;
            }

            pushBlock({
                type:
                    "paragraph",

                html:
                    sanitizeHtml(
                        element.innerHTML
                    ),

                text:
                    normalizedText(
                        element
                    ),
            });

            return;
        }
        if (tag === "div") {
            let htmlBuffer = "";

            const flushHtmlBuffer = () => {
                const html =
                    htmlBuffer.trim();

                if (!html) {
                    htmlBuffer = "";
                    return;
                }

                const temp =
                    element.ownerDocument.createElement(
                        "div"
                    );

                temp.innerHTML = html;

                const text =
                    normalizedText(temp);

                if (!text) {
                    htmlBuffer = "";
                    return;
                }

                pushBlock({
                    type: "paragraph",
                    html: sanitizeHtml(html),
                    text,
                });

                htmlBuffer = "";
            };

            for (
                const node
                of Array.from(element.childNodes)
            ) {
                /*
                 * Direct text in the div becomes
                 * paragraph content.
                 */
                if (
                    node.nodeType ===
                    node.TEXT_NODE
                ) {
                    htmlBuffer +=
                        node.textContent ?? "";

                    continue;
                }

                if (
                    node.nodeType !==
                    node.ELEMENT_NODE
                ) {
                    continue;
                }

                const child =
                    node as Element;

                const childTag =
                    child.tagName.toLowerCase();

                /*
                 * Inline markup stays attached to
                 * the surrounding text.
                 */
                const inlineTags =
                    new Set([
                        "a",
                        "strong",
                        "b",
                        "em",
                        "i",
                        "span",
                        "small",
                        "mark",
                        "u",
                        "s",
                        "sup",
                        "sub",
                        "code",
                    ]);

                if (inlineTags.has(childTag)) {
                    htmlBuffer +=
                        child.outerHTML;

                    continue;
                }

                /*
                 * We've hit a block-level child:
                 * finish any text before it...
                 */
                flushHtmlBuffer();

                /*
                 * ...then process the child normally.
                 *
                 * This is what allows <table>,
                 * <p>, <img>, headings, etc.
                 * to become their own blocks.
                 */
                walkHtml(child);
            }

            flushHtmlBuffer();

            return;
        }
        for (const child of Array.from(element.children)) {
            walkHtml(child);
        }
    }

    walkHtml(root);
    return blocks;
}

function collectArticleImageUrls(
    blocks: ArticleBlock[],
    thumbnailUrl: string | null,
    articleUrl: string
): string[] {
    const imageUrls =
        new Set<string>();

    for (const block of blocks) {
        /*
         * Standalone image blocks.
         */
        if (
            block.type === "image" &&
            block.src
        ) {
            imageUrls.add(
                block.src
            );
        }

        /*
         * Images embedded inside blockquotes,
         * tables, lists, etc.
         */
        if (block.html) {
            const wrapper =
                block.type === "table"
                    ? `<table>${block.html}</table>`
                    : `<div>${block.html}</div>`;

            const dom =
                new JSDOM(
                    `<body>${wrapper}</body>`
                );

            const images =
                dom.window.document
                    .querySelectorAll(
                        "img"
                    );

            for (const image of images) {
                const src =
                    image.getAttribute(
                        "src"
                    );

                if (!src) {
                    continue;
                }

                try {
                    imageUrls.add(
                        new URL(
                            src,
                            articleUrl
                        ).href
                    );
                } catch {
                    // Ignore malformed URLs.
                }
            }
        }
    }

    /*
     * Include the thumbnail even when Readability
     * didn't include it in the article body.
     */
    if (thumbnailUrl) {
        try {
            imageUrls.add(
                new URL(
                    thumbnailUrl,
                    articleUrl
                ).href
            );
        } catch {
            // Ignore malformed thumbnail URL.
        }
    }

    return [
        ...imageUrls,
    ];
}

async function blocksToHtml(
    blocks: ArticleBlock[],
    title: string,
    includeHeader: boolean,
    thumbnailUrl: string | null,
    articleUrl: string,
    allowBrowserHarvest = true
) {
    const imageUrls =
        collectArticleImageUrls(
            blocks,
            thumbnailUrl,
            articleUrl
        );

    const wallabagImages =
        await prepareWallabagImages(
            [...imageUrls],
            articleUrl,
            allowBrowserHarvest
        );

    function localizeEmbeddedImages(
        block: ArticleBlock,
        wallabagImages: Map<string, string>,
        articleUrl: string
    ): string {
        const html =
            block.html ?? "";

        if (!html) {
            return "";
        }

        const wrapper =
            block.type === "table"
                ? `<table>${html}</table>`
                : `<div>${html}</div>`;

        const dom =
            new JSDOM(
                `<body>${wrapper}</body>`
            );

        const document =
            dom.window.document;

        for (
            const image
            of document.querySelectorAll("img")
        ) {
            const src =
                image.getAttribute("src");

            if (!src) {
                continue;
            }

            let absoluteUrl: string;

            try {
                absoluteUrl =
                    new URL(
                        src,
                        articleUrl
                    ).href;
            } catch {
                continue;
            }

            const localUrl =
                wallabagImages.get(
                    absoluteUrl
                );

            if (localUrl) {
                image.setAttribute(
                    "src",
                    localUrl
                );

                image.removeAttribute(
                    "srcset"
                );

                image.removeAttribute(
                    "data-srcset"
                );
            }
        }

        if (block.type === "table") {
            return (
                document
                    .querySelector("table")
                    ?.innerHTML ??
                html
            );
        }

        return (
            document
                .querySelector("div")
                ?.innerHTML ??
            html
        );
    }

    const innerParts = await Promise.all(
        blocks.map(async (block) => {
            const localizedHtml =
                localizeEmbeddedImages(
                    block,
                    wallabagImages,
                    articleUrl
                );
            if (block.type === "image") {
                if (!block.src) {
                    return "";
                }

                const localUrl =
                    wallabagImages.get(
                        block.src
                    );

                if (!localUrl) {
                    return "";
                }

                return `
                    <p>
                        <img
                            src="${localUrl}"
                            alt="${block.alt ?? ""}"
                        >
                    </p>
                `;
            }

            if (block.type === "heading") {
                return `<h${block.level}>${localizedHtml ?? ""}</h${block.level}>`;
            }

            if (block.type === "paragraph") {
                return `<p>${localizedHtml ?? ""}</p>`;
            }

            if (
                block.type === "ul" ||
                block.type === "ol"
            ) {
                return `<${block.type}>${localizedHtml ?? ""}</${block.type}>`;
            }

            if (block.type === "blockquote") {
                return `<blockquote>${localizedHtml ?? ""}</blockquote>`;
            }

            if (block.type === "table") {
                return `
                    <table>
                        ${localizedHtml ?? ""}
                    </table>
                `;
            }

            return "";
        })
    );

    const inner =
        innerParts.join("");

    const head = thumbnailUrl
        ? `
            <head>
                <meta
                    property="og:image"
                    content="${thumbnailUrl}"
                >
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
        ["paragraph", "blockquote", "ul", "ol", "table"].includes(block.type) &&
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

function getDataBgFallback(
    document: Document,
    pageUrl: string
): string | null {
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

                return new URL(
                    value.src,
                    pageUrl
                ).href;
            }
        } catch {
            // ignore malformed data-b-bg
        }
    }

    return null;
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

function getFirstContentImage(
    document: Document,
    pageUrl: string
): string | null {
    const images = Array.from(
        document.querySelectorAll("img")
    );

    for (const img of images) {
        if (img.closest("header, footer")) {
            continue;
        }

        const src = getImageSrc(img, pageUrl);

        if (src) {
            return src;
        }
    }

    return null;
}

async function getCartoonResearchFeaturedImage(
    articleUrl: string,
): Promise<string | null> {
    try {
        const pageUrl =
            new URL(articleUrl);

        const apiBase =
            `${pageUrl.origin}/wp-json/wp/v2`;

        /*
         * Search WordPress for the current post.
         */
        const articleSlug =
            pageUrl.pathname
                .split("/")
                .filter(Boolean)
                .pop();

        if (!articleSlug) {
            return null;
        }

        const searchUrl =
            `${apiBase}/posts` +
            `?slug=${encodeURIComponent(articleSlug)}`;

        const response =
            await fetch(searchUrl);

        if (!response.ok) {
            console.warn(
                "Cartoon Research post lookup failed:",
                response.status
            );

            return null;
        }

        const posts =
            await response.json();

        if (
            !Array.isArray(posts) ||
            posts.length === 0
        ) {
            console.warn(
                "Cartoon Research: no REST post for slug:",
                articleSlug
            );

            return null;
        }

        const post =
            posts[0];

        if (!post.featured_media) {
            console.warn(
                "Cartoon Research: no featured media for:",
                articleSlug
            );

            return null;
        }

        /*
         * Fetch the attached media item.
         */
        const mediaResponse =
            await fetch(
                `${apiBase}/media/${post.featured_media}`
            );

        if (!mediaResponse.ok) {
            console.warn(
                "Cartoon Research media lookup failed:",
                mediaResponse.status
            );

            return null;
        }

        const media =
            await mediaResponse.json();

        /*
         * Prefer a reasonably large generated
         * thumbnail if WordPress exposes one.
         */
        const sizes =
            media.media_details?.sizes;

        const sizeEntries =
            Object.values(
                sizes ?? {}
            ) as Array<{
                source_url?: string;
                width?: number;
                height?: number;
            }>;

        const widest =
            sizeEntries
                .filter(
                    size =>
                        size.source_url &&
                        typeof size.width === "number"
                )
                .sort(
                    (a, b) =>
                        (b.width ?? 0) -
                        (a.width ?? 0)
                )[0];

        return (
            widest?.source_url ??
            media.source_url ??
            null
        );
    } catch (error) {
        console.warn(
            "Could not get Cartoon Research featured image:",
            error
        );

        return null;
    }
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

    if (imageSrc) {
        // 1. Prefer exact matching data-b-bg image.
        const resolved = resolveImageSrc(
            document,
            imageSrc,
            pageUrl
        );

        if (resolved) {
            return resolved;
        }

        // 2. Look for an exact matching normal <img>.
        const targetFilename = normalizedImageFilename(
            imageSrc,
            pageUrl
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

        // 3. Only now use a different data-b-bg image.
        const dataBgFallback = getDataBgFallback(
            document,
            pageUrl
        );

        if (dataBgFallback) {
            return dataBgFallback;
        }
    }

    const twitterImage = document
        .querySelector('meta[name="twitter:image"]')
        ?.getAttribute("content");

    if (twitterImage) {
        return new URL(twitterImage, pageUrl).href;
    }
    const firstContentImage = getFirstContentImage(
        document,
        pageUrl
    );

    if (firstContentImage) {
        return firstContentImage;
    }

    return null;
}

function getJsonLdObjects(document: Document): any[] {
    const objects: any[] = [];

    const scripts = document.querySelectorAll(
        'script[type="application/ld+json"]'
    );

    for (const script of scripts) {
        const text = script.textContent?.trim();

        if (!text) {
            continue;
        }

        try {
            const parsed = JSON.parse(text);

            if (Array.isArray(parsed)) {
                objects.push(...parsed);
            } else if (parsed["@graph"]) {
                objects.push(...parsed["@graph"]);
            } else {
                objects.push(parsed);
            }
        } catch {
            // Ignore malformed JSON-LD
        }
    }

    return objects;
}

function getJsonLdValue(
    document: Document,
    key: string
): unknown {
    const objects = getJsonLdObjects(document);

    for (const obj of objects) {
        if (
            obj &&
            typeof obj === "object" &&
            key in obj
        ) {
            return obj[key];
        }
    }

    return null;
}

function dateTextToIso(
    value: string
): string | null {
    const parsed =
        new Date(value);

    if (
        Number.isNaN(
            parsed.getTime()
        )
    ) {
        return null;
    }

    /*
     * This fallback only knows the calendar
     * date, not the actual publication time.
     */
    const year =
        parsed.getFullYear();

    const month =
        String(
            parsed.getMonth() + 1
        ).padStart(2, "0");

    const day =
        String(
            parsed.getDate()
        ).padStart(2, "0");

    return (
        `${year}-${month}-${day}` +
        `T00:00:00Z`
    );
}

function getPublishDate(document: Document): string | null {
    const ogPublished = document
        .querySelector('meta[property="article:published_time"]')
        ?.getAttribute("content");

    if (ogPublished) {
        return ogPublished;
    }

    const metaDate = document
        .querySelector('meta[name="date"]')
        ?.getAttribute("content");

    if (metaDate) {
        return metaDate;
    }

    const time = document
        .querySelector("time[datetime]")
        ?.getAttribute("datetime");

    if (time) {
        return time;
    }

    const jsonLdDate = getJsonLdValue(
        document,
        "datePublished"
    );

    if (typeof jsonLdDate === "string") {
        return jsonLdDate;
    }

    /*
 * Older WordPress/theme markup.
 */
    const dateSelectors = [
        ".entry-date",
        ".post-date",
        ".post_date",
        ".published",
        ".date",
    ];

    for (
        const selector
        of dateSelectors
    ) {
        const text =
            document
                .querySelector(selector)
                ?.textContent
                ?.trim();

        if (!text) {
            continue;
        }

        const parsed =
            dateTextToIso(text);

        if (parsed) {
            return parsed;
        }
    }

    /*
     * Last-resort textual fallback.
     *
     * Cartoon Research uses text resembling:
     *
     * March 17, 2023 posted by Jim Korkis
     */
    const bodyText =
        document.body.textContent
            ?.replace(/\s+/g, " ")
            .trim()
        ?? "";

    const dateMatch =
        bodyText.match(
            /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/i
        );

    if (dateMatch) {
        const parsed =
            dateTextToIso(
                dateMatch[0]
            );

        if (parsed) {
            return parsed;
        }
    }

    return null;
}

function extractAuthorFromBylineText(
    value: string | null | undefined
): string | null {
    if (!value) {
        return null;
    }

    const text =
        value
            .replace(/\u00A0/g, " ")
            .replace(/\s+/g, " ")
            .trim();

    /*
     * Handles:
     *
     * posted by Jim Korkis
     * written by Jim Korkis
     * by Jim Korkis
     *
     * The name stops at common metadata
     * separators if they exist.
     */
    const match =
        text.match(
            /\b(?:posted\s+by|written\s+by|by)\s+([^|•·–—]+?)(?=\s*(?:[|•·–—]|$))/i
        );

    if (!match?.[1]) {
        return null;
    }

    let author =
        match[1]
            .replace(/\s+/g, " ")
            .trim();

    /*
     * Avoid accidentally accepting a large
     * sentence as somebody's name.
     */
    if (
        author.length === 0 ||
        author.length > 80
    ) {
        return null;
    }

    const wordCount =
        author.split(/\s+/).length;

    if (wordCount > 8) {
        return null;
    }

    return author;
}

function getVisibleBylineAuthor(
    document: Document
): string | null {
    /*
     * First inspect common metadata/byline
     * containers used by WordPress and other
     * older publishing systems.
     */
    const selectors = [
        "[rel='author']",
        ".byline",
        ".author",
        ".entry-author",
        ".post-author",
        ".entry-meta",
        ".post-meta",
        ".post-info",
        ".entry-info",
        ".meta",
    ];

    for (const selector of selectors) {
        const elements =
            document.querySelectorAll(
                selector
            );

        for (const element of elements) {
            const author =
                extractAuthorFromBylineText(
                    element.textContent
                );

            if (author) {
                return author;
            }

            /*
             * A rel=author link often contains
             * only the person's name, without
             * the literal word "by".
             */
            if (
                element.matches(
                    "[rel='author']"
                )
            ) {
                const name =
                    element.textContent
                        ?.replace(/\s+/g, " ")
                        .trim();

                if (
                    name &&
                    name.length <= 80
                ) {
                    return name;
                }
            }
        }
    }

    /*
     * Fallback for sites such as Cartoon
     * Research where:
     *
     * March 17, 2023 posted by Jim Korkis
     * <h1>Article title</h1>
     *
     * Only inspect content near the H1.
     * Do NOT search the whole body for "by".
     */
    const heading =
        document.querySelector("h1");

    if (!heading) {
        return null;
    }

    /*
     * Check preceding siblings first.
     */
    let sibling =
        heading.previousElementSibling;

    for (
        let i = 0;
        sibling && i < 6;
        i++
    ) {
        const author =
            extractAuthorFromBylineText(
                sibling.textContent
            );

        if (author) {
            return author;
        }

        sibling =
            sibling.previousElementSibling;
    }

    /*
     * Some themes wrap the title and metadata
     * together. Inspect that small parent
     * container as a final fallback.
     */
    const parent =
        heading.parentElement;

    if (parent) {
        const parentText =
            parent.textContent
                ?.replace(/\s+/g, " ")
                .trim();

        /*
         * Limit this fallback so we don't scan a
         * giant element containing the whole post.
         */
        if (
            parentText &&
            parentText.length <= 1000
        ) {
            const author =
                extractAuthorFromBylineText(
                    parentText
                );

            if (author) {
                return author;
            }
        }
    }

    return null;
}

function getAuthors(document: Document): string[] {
    const authors = new Set<string>();

    const metaAuthor = document
        .querySelector('meta[name="author"]')
        ?.getAttribute("content");

    if (metaAuthor?.trim()) {
        authors.add(metaAuthor.trim());
    }

    const articleAuthors = document.querySelectorAll(
        'meta[property="article:author"]'
    );

    for (const element of articleAuthors) {
        const content = element.getAttribute("content");

        if (content?.trim()) {
            authors.add(content.trim());
        }
    }

    const jsonLdAuthors = getJsonLdValue(
        document,
        "author"
    );

    if (Array.isArray(jsonLdAuthors)) {
        for (const author of jsonLdAuthors) {
            if (typeof author === "string") {
                authors.add(author.trim());
            } else if (
                author &&
                typeof author === "object" &&
                typeof author.name === "string"
            ) {
                authors.add(author.name.trim());
            }
        }
    } else if (
        jsonLdAuthors &&
        typeof jsonLdAuthors === "object" &&
        "name" in jsonLdAuthors &&
        typeof jsonLdAuthors.name === "string"
    ) {
        authors.add(
            jsonLdAuthors.name.trim()
        );
    } else if (
        typeof jsonLdAuthors === "string"
    ) {
        authors.add(
            jsonLdAuthors.trim()
        );
    }

    /*
     * No structured author metadata?
     *
     * Fall back to a visible byline near
     * the article title.
     */
    if (authors.size === 0) {
        const bylineAuthor =
            getVisibleBylineAuthor(
                document
            );

        if (bylineAuthor) {
            authors.add(
                bylineAuthor
            );
        }
    }

    return [...authors];
}

function cleanArticleTitle(
    title: string
): string {
    return title
        .replace(/\s*\|\s*$/, "")
        .trim();
}

function sleep(
    ms: number
): Promise<void> {
    return new Promise(
        resolve =>
            setTimeout(
                resolve,
                ms
            )
    );
}

function randomDelay(
    minMs: number,
    maxMs: number
): number {
    return (
        minMs +
        Math.floor(
            Math.random() *
            (maxMs - minMs + 1)
        )
    );
}

async function fetchWithRetry(
    url: string,
    options?: RequestInit,
    maxAttempts = 5
): Promise<Response> {
    let lastError:
        unknown = null;

    for (
        let attempt = 1;
        attempt <= maxAttempts;
        attempt++
    ) {
        try {
            const response =
                await fetch(
                    url,
                    options
                );

            /*
             * Success or a non-transient
             * HTTP error.
             */
            if (
                response.ok ||
                (
                    response.status < 500 &&
                    response.status !== 429
                )
            ) {
                return response;
            }

            lastError =
                new Error(
                    `HTTP ${response.status}`
                );
        } catch (error) {
            lastError =
                error;
        }

        if (
            attempt <
            maxAttempts
        ) {
            /*
             * 1 min
             * 2 min
             * 4 min
             * 8 min
             */
            const delay =
                60_000 *
                Math.pow(
                    2,
                    attempt - 1
                );

            console.warn(
                `Request failed: ${url}`
            );

            console.warn(
                `Retry ${attempt + 1}/${maxAttempts} ` +
                `in ${Math.round(delay / 60_000)} minute(s)`
            );

            await sleep(
                delay
            );
        }
    }

    throw (
        lastError ??
        new Error(
            `Request failed: ${url}`
        )
    );
}

type SouthBayArchiveArticle = {
    url: string;
};

async function getSouthBayArchiveArticles(
    pageNumber: number
): Promise<
    SouthBayArchiveArticle[] | null
> {
    const archiveUrl =
        pageNumber === 1
            ? "https://sbhistoryblog.wordpress.com/author/samgnerre1gmailcom/"
            : `https://sbhistoryblog.wordpress.com/author/samgnerre1gmailcom/page/${pageNumber}/`;

    console.log(
        "Fetching South Bay History archive:",
        archiveUrl
    );

    const response =
        await fetchWithRetry(
            archiveUrl
        );

    /*
     * WordPress normally returns 404 once
     * we've gone past the last archive page.
     *
     * null means:
     *     "there are no more pages"
     */
    if (
        response.status === 404
    ) {
        console.log(
            "Reached end of South Bay History archive."
        );

        return null;
    }

    if (!response.ok) {
        throw new Error(
            `South Bay archive page ${pageNumber} failed: ` +
            response.status
        );
    }

    const html =
        await response.text();

    const dom =
        new JSDOM(
            html,
            {
                url:
                    archiveUrl,
            }
        );

    const urls =
        new Set<string>();

    /*
     * Post URLs on this WordPress site use:
     *
     * /YYYY/MM/DD/article-slug/
     *
     * This prevents archive/category/navigation
     * links from entering the importer.
     */
    const links =
        dom.window.document
            .querySelectorAll(
                "a[href]"
            );

    for (const link of links) {
        const href =
            link.getAttribute(
                "href"
            );

        if (!href) {
            continue;
        }

        let resolved:
            URL;

        try {
            resolved =
                new URL(
                    href,
                    archiveUrl
                );
        } catch {
            continue;
        }

        if (
            resolved.hostname !==
            "sbhistoryblog.wordpress.com"
        ) {
            continue;
        }

        if (
            !/^\/\d{4}\/\d{2}\/\d{2}\/[^/]+\/?$/
                .test(
                    resolved.pathname
                )
        ) {
            continue;
        }

        /*
         * Normalize the article URL before
         * deduplicating it.
         *
         * Different links to the same WordPress post
         * can contain query strings or fragments.
         */
        resolved.search = "";
        resolved.hash = "";

        /*
         * Normalize trailing slash too.
         */
        if (
            !resolved.pathname.endsWith("/")
        ) {
            resolved.pathname += "/";
        }

        urls.add(
            resolved.href
        );
    }

    const articles =
        [...urls].map(
            url => ({
                url,
            })
        );

    console.log(
        `South Bay page ${pageNumber}: ` +
        `${articles.length} article(s)`
    );

    /*
     * Also treat an unexpectedly empty page
     * as the end of the archive.
     */
    if (
        articles.length === 0
    ) {
        return null;
    }

    return articles;
}

async function extractFromHtml(
    html: string,
    url: string,
) {
    const originalDom = new JSDOM(html, { url });
    const dom = new JSDOM(html, { url });

    const article = new Readability(dom.window.document).parse();
    const articleDOM = new JSDOM(article!.content!, { url });

    if (!article) {
        throw new Error(
            "Could not extract article"
        );
    }
    const originalContent = extractBlocks(originalDom.window.document.body, url, true);
    const articleContent = extractBlocks(articleDOM.window.document.body, url, false);
    
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
            const articleText = articleBlock.text.trim();

            // Only use substring matching for substantial text.
            if (articleText.length >= 40) {
                const fallbackMatch = originalContent.find(originalBlock => {
                    if (
                        originalBlock.type !== articleBlock.type ||
                        !originalBlock.text
                    ) {
                        return false;
                    }

                    return originalBlock.text.includes(articleText);
                });

                if (fallbackMatch?.sourceIndex !== undefined) {
                    articleBlock.sourceIndex = fallbackMatch.sourceIndex;
                }
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

    const dedupedArticleContent =
        articleContent.filter(
            (block, index, blocks) => {
                if (
                    block.type !== "image" ||
                    !block.src
                ) {
                    return true;
                }

                return !blocks
                    .slice(0, index)
                    .some(previous => {
                        if (
                            previous.type !== "image" ||
                            !previous.src
                        ) {
                            return false;
                        }

                        return (
                            previous.sourceIndex ===
                            block.sourceIndex &&
                            previous.src ===
                            block.src
                        );
                    });
            }
        );

    /*
 * Give every Readability block a stable display position.
 *
 * sourceIndex means:
 *     "this block matched something in the original DOM"
 *
 * displayOrder means:
 *     "this is where the block should appear in the editor"
 */

    // Matched blocks get positions based on the original DOM.
    for (const block of dedupedArticleContent) {
        if (block.sourceIndex !== undefined) {
            block.displayOrder =
                block.sourceIndex * 1000;
        }
    }

    /*
     * Fill in unmatched Readability blocks using
     * the nearest matched blocks around them.
     */
    for (
        let i = 0;
        i < dedupedArticleContent.length;
        i++
    ) {
        const block =
            dedupedArticleContent[i]!;

        if (
            block.displayOrder !== undefined
        ) {
            continue;
        }

        const previous =
            dedupedArticleContent
                .slice(0, i)
                .reverse()
                .find(
                    candidate =>
                        candidate.displayOrder !==
                        undefined
                );

        const next =
            dedupedArticleContent
                .slice(i + 1)
                .find(
                    candidate =>
                        candidate.displayOrder !==
                        undefined
                );

        /*
         * Unmatched block sits between two
         * successfully matched blocks.
         */
        if (
            previous?.displayOrder !== undefined &&
            next?.displayOrder !== undefined
        ) {
            block.displayOrder =
                (
                    previous.displayOrder +
                    next.displayOrder
                ) / 2;

            continue;
        }

        /*
         * Unmatched block is after the last
         * successfully matched block.
         */
        if (
            previous?.displayOrder !== undefined
        ) {
            block.displayOrder =
                previous.displayOrder + 1;

            continue;
        }

        /*
         * Unmatched block is before the first
         * successfully matched block.
         */
        if (
            next?.displayOrder !== undefined
        ) {
            block.displayOrder =
                next.displayOrder - 1;

            continue;
        }

        /*
         * Nothing matched at all.
         * Fall back to Readability order.
         */
        block.displayOrder =
            block.readIndex ?? i;
    }

    for (const block of originalContent) {
        if (
            block.sourceIndex !== undefined
        ) {
            block.displayOrder =
                block.sourceIndex * 1000;
        }
    }

    const missingContent = originalContent
        .filter(
            block =>
                !isOriginalBlockCovered(
                    block,
                    dedupedArticleContent
                )
        )
        .map(block => ({
            ...block,
            category: classifyMissingBlock(
                block,
                article.title!
            ),
        }));

    let thumbnailUrl = getThumbnailUrl(
        originalDom.window.document,
        url,
        originalContent,
        dedupedArticleContent
    );

    const hostname =
        new URL(url)
            .hostname
            .replace(/^www\./, "");


    const readabilityTitle = cleanArticleTitle(article.title ?? "");

    const metadataTitle =
        cleanArticleTitle(
            originalDom.window.document
                .querySelector('meta[property="og:title"]')
                ?.getAttribute("content")
                ?.trim()
            ??
            originalDom.window.document.title.trim()
        );

    if (
        hostname ===
        "cartoonresearch.com"
    ) {
        const featuredImage =
            await getCartoonResearchFeaturedImage(
                url
            );

        if (featuredImage) {
            thumbnailUrl =
                featuredImage;
        }
    }
    const publishDate = getPublishDate(
        originalDom.window.document
    );

    const authors = getAuthors(
        originalDom.window.document
    );
    return ({
        url,
        readabilityTitle,
        metadataTitle,
        articleContent: dedupedArticleContent,
        missingContent,
        thumbnailUrl,
        publishDate,
        authors
    })
}

type CartoonResearchArchiveArticle = {
    url: string;
    thumbnailUrl: string | null;
};

async function getCartoonResearchArchiveArticles(
    pageNumber: number
): Promise<CartoonResearchArchiveArticle[]> {
    const archiveUrl =
        pageNumber === 1
            ? "https://cartoonresearch.com/index.php/category/the-other-disney-cartoons/"
            : `https://cartoonresearch.com/index.php/category/the-other-disney-cartoons/page/${pageNumber}/`;

    console.log(
        "Fetching Cartoon Research archive:",
        archiveUrl
    );

    const response =
        await fetch(archiveUrl);

    if (!response.ok) {
        throw new Error(
            `Cartoon Research archive page ${pageNumber} failed: ${response.status}`
        );
    }

    const html =
        await response.text();

    const dom =
        new JSDOM(
            html,
            {
                url: archiveUrl,
            }
        );

    const articles:
        CartoonResearchArchiveArticle[] = [];

    const entries =
        dom.window.document
            .querySelectorAll(
                "article.entry-post"
            );

    for (const entry of entries) {
        const link =
            entry.querySelector(
                "h3.entry-title a[href]"
            );

        const href =
            link?.getAttribute("href");

        if (!href) {
            continue;
        }

        const image =
            entry.querySelector(
                ".entry-thumb img"
            );

        /*
         * Use your existing image resolver so
         * src/srcset/lazy-loading variants still work.
         */
        const thumbnailUrl =
            image
                ? getImageSrc(
                    image,
                    archiveUrl
                )
                : null;

        articles.push({
            url:
                new URL(
                    href,
                    archiveUrl
                ).href,

            thumbnailUrl,
        });
    }

    console.log(
        `Archive page ${pageNumber}: found ${articles.length} articles`
    );

    return articles;
}

app.post("/api/extract", async (req, res) => {
    try {
        const url = req.body.url;

        const html = await fetchArticleHtml(url);

        const result = await extractFromHtml(html, url);

        res.json(result);
    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Failed to extract article",
        });
    }
});

app.post(
    "/api/cache-image",
    express.raw({
        type: "application/octet-stream",
        limit: "50mb",
    }),
    (req, res) => {
        try {
            const imageUrl =
                req.query.url;

            const contentType =
                req.query.contentType;

            if (
                typeof imageUrl !== "string" ||
                typeof contentType !== "string"
            ) {
                return res.status(400).json({
                    error:
                        "Missing url or contentType",
                });
            }

            if (!Buffer.isBuffer(req.body)) {
                return res.status(400).json({
                    error:
                        "Expected binary image body",
                });
            }

            cacheImage(
                imageUrl,
                contentType,
                req.body
            );

            console.log(
                "Cached extension image:",
                imageUrl
            );

            res.json({
                success: true,
            });
        } catch (error) {
            console.error(
                "Could not cache extension image:",
                error
            );

            res.status(500).json({
                error:
                    "Could not cache image",
            });
        }
    }
);

app.post("/api/extract-html", async (req, res) => {
    try {
        const {
            url,
            html,
        } = req.body;

        if (
            typeof url !== "string" ||
            typeof html !== "string"
        ) {
            return res.status(400).json({
                error: "Invalid request body",
            });
        }

        const article =
            await extractFromHtml(
                html,
                url
            );

        const id =
            crypto.randomUUID();

        pendingArticles.set(id, {
            createdAt:
                Date.now(),

            article,
        });

        /*
         * Tell the extension exactly which
         * images survived extraction.
         */
        const imageUrls =
            collectArticleImageUrls(
                [
                    ...(article.articleContent ?? []),
                    ...(article.missingContent ?? []),
                ],
                article.thumbnailUrl ?? null,
                url
            );

        res.json({
            id,
            imageUrls,
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            error:
                "Failed to extract supplied HTML",
        });
    }
});

app.get("/api/extracted/:id", (req, res) => {
    const item =
        pendingArticles.get(
            req.params.id
        );

    if (!item) {
        return res.status(404).json({
            error: "Article not found",
        });
    }

    res.json(item.article);
});

app.post("/api/sendinstapaper", async (req, res) => {
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

        const html = await blocksToHtml(finalContent, title, includeHeader, thumbnailurl, url);

        const instapaperUrl =
            "https://www.instapaper.com/api/1/bookmarks/add";

        const body = {
            url,
            title,
            //resolve_final_url: "0",
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

async function sendExtractedArticleToWallabag(
    article: {
        url: string;
        readabilityTitle: string;
        metadataTitle: string;
        articleContent: ArticleBlock[];
        thumbnailUrl: string | null;
        publishDate: string | null;
        authors: string[];
    }
) {
    const url =
        article.url;

    const title =
        article.readabilityTitle ||
        article.metadataTitle;

    const finalContent =
        article.articleContent;

    const thumbnailUrl =
        article.thumbnailUrl;

    const publishDate =
        article.publishDate ?? "";

    const authors =
        article.authors?.join(", ") ?? "";

    /*
     * Save the thumbnail into Wallabag's
     * local image storage.
     */
    const previewResult =
        thumbnailUrl
            ? await saveImageForWallabag(
                thumbnailUrl,
                url
            )
            : null;

    const localPreviewPicture =
        previewResult?.url ?? "";

    await wallabagAuth();

    /*
     * Batch imports came from backend fetching,
     * not from the extension cache, so browser
     * harvesting is allowed here.
     */
    const html =
        await blocksToHtml(
            finalContent,
            title,
            false,
            thumbnailUrl,
            url,
            true
        );

    const wallabagUrl =
        "http://192.168.0.199:8080/api/entries";

    const body = {
        url,
        title,
        content:
            html,
        published_at:
            publishDate,
        authors,
        preview_picture:
            localPreviewPicture,
    };

    const formData =
        new URLSearchParams(body);

    const response =
        await fetch(
            wallabagUrl,
            {
                method: "POST",

                headers: {
                    Authorization:
                        `Bearer ${wallabagAccessToken}`,

                    "Content-Type":
                        "application/x-www-form-urlencoded",
                },

                body:
                    formData.toString(),
            }
        );

    const responseText =
        await response.text();

    if (!response.ok) {
        throw new Error(
            `Wallabag request failed ${response.status}: ${responseText}`
        );
    }

    return JSON.parse(
        responseText
    );
}

app.post("/api/sendwallabag", async (req, res) => {
    try {
        const url = req.body.url as string;
        const title = req.body.title as string;
        const finalContent = req.body.finalContent as ArticleBlock[];
        const includeHeader = req.body.includeHeader as boolean;
        const thumbnailurl = req.body.thumbnailUrl as string | null;
        const previewResult = thumbnailurl
            ? await saveImageForWallabag(
                thumbnailurl,
                url
            )
            : null;

        const localPreviewPicture =
            previewResult?.url ?? "";
        const publishDate = req.body.publishDate as string;
        const authors = req.body.authors as string;
        const fromExtension = req.body.fromExtension === true;

        if (!url || !title || !Array.isArray(finalContent)) {
            return res.status(400).json({
                error: "Invalid request body",
            });
        }
        await wallabagAuth();
        const html = await blocksToHtml(finalContent, title, includeHeader, thumbnailurl, url, !fromExtension);

        const chickenIndex = html.indexOf("🍗");

        if (chickenIndex !== -1) {
            console.log(
                "CHICKEN CONTEXT:",
                html.slice(
                    Math.max(0, chickenIndex - 300),
                    chickenIndex + 300
                )
            );
        }

        const instapaperUrl =
            "http://192.168.0.199:8080/api/entries";

        const body = {
            url,
            title,
            content: html,
            published_at: publishDate,
            authors,
            preview_picture: localPreviewPicture
        };

        const requestData = {
            url: instapaperUrl,
            method: "POST",
            data: body,
        };

        const formData = new URLSearchParams(body);

        const encodedBody = formData.toString();

        console.log(
            "REQUEST HAS CHICKEN UTF-8:",
            encodedBody.includes("%F0%9F%8D%97")
        );

        console.log(
            "REQUEST HAS CORRUPTED F357:",
            encodedBody.toUpperCase().includes("%EF%8D%97")
        );

        const response = await fetch(instapaperUrl, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${wallabagAccessToken}`,
                "Content-Type":
                    "application/x-www-form-urlencoded",
            },
            body: encodedBody,
        });

        const responseText = await response.text();

        console.log(
            "WALLABAG RESPONSE HAS CHICKEN:",
            responseText.includes("🍗")
        );

        console.log(
            "WALLABAG RESPONSE HAS F357:",
            responseText.includes("\uF357")
        );
        console.log(
            "WALLABAG RAW RESPONSE:",
            responseText
        );
        const wallabagEntry =
            JSON.parse(responseText);

        console.log(
            "CREATED WALLABAG ENTRY ID:",
            wallabagEntry.id
        );
        const storedResponse =
            await fetch(
                `http://192.168.0.199:8080/api/entries/${wallabagEntry.id}`,
                {
                    headers: {
                        "Authorization":
                            `Bearer ${wallabagAccessToken}`,
                    },
                }
            );

        const storedEntry =
            await storedResponse.json();

        const storedContent =
            storedEntry.content ?? "";

        console.log(
            "STORED HAS CHICKEN:",
            storedContent.includes("\u{1F357}")
        );

        console.log(
            "STORED HAS F357:",
            storedContent.includes("\uF357")
        );
        for (const char of storedContent) {
            const codePoint =
                char.codePointAt(0)!;

            if (codePoint > 127) {
                console.log(
                    "STORED NON-ASCII:",
                    JSON.stringify(char),
                    "U+" +
                    codePoint
                        .toString(16)
                        .toUpperCase()
                );
            }
        }

        if (!response.ok) {
            console.error(
                "Wallabag error:",
                response.status,
                responseText
            );

            return res.status(502).json({
                error: "Wallabag request failed",
                status: response.status,
                details: responseText,
            });
        }

        res.json({
            message: "Sent to Wallabag",
            response: responseText,
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Failed to send article to Wallabag",
        });
    }
});

app.post(
    "/api/batch-cartoonresearch",
    async (req, res) => {
        try {
            const startPage =
                Number(
                    req.body.startPage
                );

            const endPage =
                Number(
                    req.body.endPage
                );

            if (
                !Number.isInteger(
                    startPage
                ) ||
                !Number.isInteger(
                    endPage
                ) ||
                startPage < 1 ||
                endPage < startPage
            ) {
                return res
                    .status(400)
                    .json({
                        error:
                            "Invalid page range",
                    });
            }

            const results:
                Array<{
                    page: number;
                    url: string;
                    status:
                    | "saved"
                    | "failed";
                    wallabagId?: number;
                    error?: string;
                }> = [];

            for (
                let page =
                    startPage;
                page <= endPage;
                page++
            ) {
                console.log(
                    `========== ARCHIVE PAGE ${page}/${endPage} ==========`
                );

                let archiveArticles:
                    CartoonResearchArchiveArticle[];

                try {
                    archiveArticles =
                        await getCartoonResearchArchiveArticles(
                            page
                        );
                } catch (error) {
                    console.error(
                        `Could not fetch archive page ${page}:`,
                        error
                    );

                    continue;
                }

                for (
                    const archiveArticle
                    of archiveArticles
                ) {
                    const url =
                        archiveArticle.url;

                    try {
                        console.log(
                            "Extracting:",
                            url
                        );

                        const html =
                            await fetchArticleHtml(
                                url
                            );

                        const article =
                            await extractFromHtml(
                                html,
                                url
                            );

                        /*
                         * IMPORTANT:
                         *
                         * For batch mode, trust the exact
                         * thumbnail Cartoon Research used
                         * on its archive card.
                         *
                         * This overrides any thumbnail
                         * guessed from the article page.
                         */
                        if (
                            archiveArticle.thumbnailUrl
                        ) {
                            article.thumbnailUrl =
                                archiveArticle.thumbnailUrl;
                        }

                        /*
 * Every article in the Animation Anecdotes
 * archive is authored by Jim Korkis.
 */
                        article.authors = [
                            "JB Kaufman"
                        ];

                        console.log(
                            "Title:",
                            article.readabilityTitle
                        );

                        console.log(
                            "Thumbnail:",
                            article.thumbnailUrl
                        );

                        const wallabagEntry =
                            await sendExtractedArticleToWallabag(
                                article
                            );

                        results.push({
                            page,
                            url,
                            status:
                                "saved",
                            wallabagId:
                                wallabagEntry.id,
                        });

                        console.log(
                            "SAVED:",
                            wallabagEntry.id,
                            url
                        );
                    } catch (error) {
                        console.error(
                            "FAILED:",
                            url,
                            error
                        );

                        results.push({
                            page,
                            url,
                            status:
                                "failed",

                            error:
                                error instanceof Error
                                    ? error.message
                                    : String(
                                        error
                                    ),
                        });
                    }

                    /*
                     * Don't hammer Cartoon Research
                     * or Wallabag.
                     */
                    await new Promise(
                        resolve =>
                            setTimeout(
                                resolve,
                                1000
                            )
                    );
                }
            }

            const saved =
                results.filter(
                    result =>
                        result.status ===
                        "saved"
                );

            const failed =
                results.filter(
                    result =>
                        result.status ===
                        "failed"
                );

            res.json({
                startPage,
                endPage,
                saved:
                    saved.length,
                failed:
                    failed.length,
                results,
            });
        } catch (error) {
            console.error(
                "Batch Cartoon Research import failed:",
                error
            );

            res.status(500).json({
                error:
                    "Batch Cartoon Research import failed",
            });
        }
    }
);

app.post(
    "/api/batch-southbayhistory",
    async (req, res) => {
        try {
            const startPage =
                Number(
                    req.body.startPage ??
                    1
                );

            const endPage =
                Number(
                    req.body.endPage
                );

            if (
                !Number.isInteger(startPage) ||
                !Number.isInteger(endPage) ||
                startPage < 1 ||
                endPage < startPage
            ) {
                return res
                    .status(400)
                    .json({
                        error:
                            "Invalid page range",
                    });
            }

            const results:
                Array<{
                    page: number;
                    url: string;
                    status:
                    | "saved"
                    | "failed";
                    wallabagId?: number;
                    error?: string;
                }> = [];

            for (
                let page = startPage;
                page <= endPage;
                page++
            ) {
                console.log(
                    ""
                );

                console.log(
                    "========================================"
                );

                console.log(
                    `SOUTH BAY HISTORY ARCHIVE PAGE ${page}`
                );

                console.log(
                    "========================================"
                );

                let archiveArticles:
                    SouthBayArchiveArticle[] |
                    null;

                try {
                    archiveArticles =
                        await getSouthBayArchiveArticles(
                            page
                        );
                } catch (error) {
                    /*
                     * fetchWithRetry already waited/retried
                     * several times before we get here.
                     *
                     * Don't silently skip an entire page.
                     * Stop so it can be resumed from this
                     * page later if necessary.
                     */
                    console.error(
                        `Archive page ${page} failed after retries:`,
                        error
                    );

                    break;
                }

                if (
                    archiveArticles ===
                    null
                ) {
                    console.log(
                        "No more archive pages."
                    );

                    break;
                }

                for (
                    let i = 0;
                    i <
                    archiveArticles.length;
                    i++
                ) {
                    const archiveArticle =
                        archiveArticles[i]!;

                    const url =
                        archiveArticle.url;

                    try {
                        console.log(
                            `[page ${page}] ` +
                            `[${i + 1}/${archiveArticles.length}] ` +
                            `Extracting ${url}`
                        );

                        /*
                         * Keep using your existing
                         * article-fetching machinery.
                         */
                        const html =
                            await fetchArticleHtml(
                                url
                            );

                        const article =
                            await extractFromHtml(
                                html,
                                url
                            );

                        /*
                         * This blog is Sam Gnerre's,
                         * so don't depend on inconsistent
                         * old WordPress byline markup.
                         */
                        article.authors = [
                            "Sam Gnerre"
                        ];

                        const wallabagEntry =
                            await sendExtractedArticleToWallabag(
                                article
                            );

                        results.push({
                            page,
                            url,
                            status:
                                "saved",
                            wallabagId:
                                wallabagEntry.id,
                        });

                        console.log(
                            "SAVED:",
                            wallabagEntry.id,
                            article.readabilityTitle
                        );
                    } catch (error) {
                        console.error(
                            "FAILED ARTICLE:",
                            url,
                            error
                        );

                        results.push({
                            page,
                            url,
                            status:
                                "failed",

                            error:
                                error instanceof Error
                                    ? error.message
                                    : String(
                                        error
                                    ),
                        });
                    }

                    /*
                     * 5–8 second breathing room
                     * between individual articles.
                     */
                    if (
                        i <
                        archiveArticles.length -
                        1
                    ) {
                        const articleDelay =
                            randomDelay(
                                5_000,
                                8_000
                            );

                        console.log(
                            `Waiting ${Math.round(
                                articleDelay /
                                1000
                            )} seconds before next article...`
                        );

                        await sleep(
                            articleDelay
                        );
                    }
                }

                /*
                 * Finished one entire archive page.
                 *
                 * Give WordPress a much larger break:
                 * 60–90 seconds.
                 */
                if (page < endPage) {
                    const pageDelay =
                        randomDelay(
                            60_000,
                            90_000
                        );

                    console.log(
                        `Finished archive page ${page}.`
                    );

                    console.log(
                        `Waiting ${Math.round(
                            pageDelay /
                            1000
                        )} seconds before next archive page...`
                    );

                    await sleep(
                        pageDelay
                    );
                }
            }

            const saved =
                results.filter(
                    result =>
                        result.status ===
                        "saved"
                );

            const failed =
                results.filter(
                    result =>
                        result.status ===
                        "failed"
                );

            res.json({
                startPage,
                endPage,

                saved:
                    saved.length,

                failed:
                    failed.length,

                results,
            });
        } catch (error) {
            console.error(
                "South Bay History batch import failed:",
                error
            );

            res
                .status(500)
                .json({
                    error:
                        "South Bay History batch import failed",
                });
        }
    }
);

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