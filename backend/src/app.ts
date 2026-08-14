import express from "express";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import type { ArticleBlock } from "../../shared/types.ts"
import cors from "cors";

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

    return `${block.type}:${block.html?.trim() ?? ""}`;
}

function getImageCandidates(element: Element, pageUrl: string): ImageCandidate[] {
    const candidates: ImageCandidate[] = [];

    const addCandidate = (
        rawUrl: string | null | undefined,
        width?: number
    ) => {
        if (!rawUrl || rawUrl.startsWith("data:")) {
            return;
        }

        try {
            const url = new URL(rawUrl, pageUrl);
            url.search = "";

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
        const tagsToSkip = ["script", "style", "nav", "form", "bottom", "iframe"];
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
            });
            return;
        }
        if (/^h[1-6]$/.test(tag)) {
            pushBlock({
                type: "heading",
                level: Number(tag[1]),
                html: sanitizeHtml(element.innerHTML),
            });
            return;
        }
        if (["ul", "ol", "blockquote"].includes(tag)) {
            pushBlock({
                type: tag,
                html: sanitizeHtml(element.innerHTML),
            });
            return;
        }
        for (const child of Array.from(element.children)) {
            walkHtml(child);
        }
    }

    walkHtml(root);
    return blocks;
}

function blocksToHtml(blocks: ArticleBlock[]) {
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

  return `<article>${inner}</article>`;
}

function imageFilename(src: string): string {
  const url = new URL(src);
  return url.pathname.split("/").pop() ?? "";
}

function sameUnderlyingImage(a: string, b: string): boolean {
  return imageFilename(a) === imageFilename(b);
}

app.post("/api/extract", async (req, res) => {
    try {
        const url = req.body.url;

        const response = await fetch(url);
        const html = await response.text();

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
        for (const articleBlock of articleContent) {
            const match = originalContent.find(
                originalBlock =>
                    blockKey(originalBlock) === blockKey(articleBlock)
            );

            if (match?.sourceIndex !== undefined) {
                articleBlock.sourceIndex = match.sourceIndex;
            }
        }
        for (const articleBlock of articleContent) {
            if (articleBlock.type !== "image") {
                continue;
            }

            const match = originalContent.find(
                (originalBlock) =>
                originalBlock.type === "image" &&
                sameUnderlyingImage(articleBlock.src!, originalBlock.src!
            ));

            if (match?.src) {
                articleBlock.src = match.src;
                if (match?.sourceIndex !== undefined) {
                    articleBlock.sourceIndex = match.sourceIndex;
                }
            }
        }
        const readabilityKeys = new Set(
            articleContent.map(blockKey)
        );

        const missingContent = originalContent.filter(
            block => !readabilityKeys.has(blockKey(block))
        );

        res.json({
            url,
            title: article.title,
            articleContent,
            missingContent,
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            error: "Failed to extract article",
        });
    }
});

app.post("/api/send", (req, res) => {
    const url = req.body.url as string;
    const title = req.body.title as string;
    const articleContent = req.body.articleContent as ArticleBlock[];
    const selectedMissingContent = req.body.selectedMissingContent as ArticleBlock[];
    const finalContent = [
    ...articleContent,
    ...selectedMissingContent
    ].sort((a, b) => a.sourceIndex! - b.sourceIndex!);
    const html = blocksToHtml(finalContent);
    res.json({
        message: "ready to send",
        url,
        title,
        html,
    });
});

app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});