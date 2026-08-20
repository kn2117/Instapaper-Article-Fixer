import { useEffect, useState } from 'react'
import './index.css'
import type { ArticleBlock } from "../../shared/types";
import { processArticle, sendArticleToInstapaper, sendArticleToWallabag } from './utils/urlUtils';
import ArticleBlockView from './components/ArticleBlock';
import MissingBlockView from './components/MissingBlock';
import { RiExpandUpDownFill } from "react-icons/ri";

function App() {
    const [url, setUrl] = useState("");
    const [processedUrl, setProcessedUrl] = useState("");
    const [articleTitle, setArticleTitle] = useState("");
    const [publishDate, setPublishDate] = useState("");
    const [authors, setAuthors] = useState("");
    const [destination, setDestination] = useState<"instapaper" | "wallabag">("wallabag");
    const [articleBlocks, setArticleBlocks] = useState<ArticleBlock[]>([]);
    const [missingBlocks, setMissingBlocks] = useState<ArticleBlock[]>([]);
    const likelyMissing = missingBlocks.filter(
        block => block.category !== "other"
    );
    const likelyJunk = missingBlocks.filter(
        block => block.category === "other"
    );
    const [selectedBlocks, setSelectedBlocks] = useState<ArticleBlock[]>([]);
    const [lastSelectedSourceIndex, setLastSelectedSourceIndex] =
        useState<number | null>(null);
    const displayedBlocks = [
        ...articleBlocks,
        ...selectedBlocks,
    ].sort((a, b) => {
        const aSource =
            a.sourceIndex ?? Number.MAX_SAFE_INTEGER;

        const bSource =
            b.sourceIndex ?? Number.MAX_SAFE_INTEGER;

        if (aSource !== bSource) {
            return aSource - bSource;
        }

        const aRead =
            a.readIndex ?? Number.MAX_SAFE_INTEGER;

        const bRead =
            b.readIndex ?? Number.MAX_SAFE_INTEGER;

        return aRead - bRead;
    });
    const [disableSubmitButton, setDisableSubmitButton] = useState<boolean>(false);
    const [disableSendToInstapaperButton, setDisableSendToInstapaperButton] = useState<boolean>(false);
    const [disableSendToWallabagButton, setDisableSendToWallabagButton] = useState<boolean>(false);
    const [includeHeader, setIncludeHeader] = useState<boolean>(false);
    const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
    const [showThumbnailModal, setShowThumbnailModal] = useState(false);
    const [customThumbnailUrl, setCustomThumbnailUrl] = useState("");
    const availableImageUrls = [
        ...new Set(
            [...articleBlocks, ...missingBlocks]
                .filter(block => block.type === "image" && block.src)
                .map(block => block.src!)
        ),
    ];
    const [readabilityTitle, setReadabilityTitle] = useState("");
    const [metadataTitle, setMetadataTitle] = useState("");
    const [selectedTitleSource, setSelectedTitleSource] = useState<"readability" | "metadata">("readability");
    const title =
        selectedTitleSource === "readability"
            ? readabilityTitle
            : metadataTitle;

    const previewTitle =
        destination === "wallabag"
            ? articleTitle
            : title;
    const previewBlocks: ArticleBlock[] =
        includeHeader
            ? [
                {
                    type: "heading",
                    level: 1,
                    html: previewTitle,
                    text: previewTitle,
                    id: "preview-title",
                },
                ...displayedBlocks,
            ]
            : displayedBlocks;
    const [editingBlock, setEditingBlock] =
        useState<ArticleBlock | null>(null);

    const [editedHtml, setEditedHtml] =
        useState("");

    useEffect(() => {
        const params =
            new URLSearchParams(
                window.location.search
            );

        const incomingUrl =
            params.get("url");

        if (incomingUrl) {
            setUrl(incomingUrl);
        }

        const articleId =
            params.get("articleId");

        if (!articleId) {
            return;
        }

        async function loadArticle() {
            const response =
                await fetch(
                    `${import.meta.env.VITE_EXTRACT_API}` +
                    `/api/extracted/${encodeURIComponent(articleId!)}`
                );

            if (!response.ok) {
                console.error(
                    "Could not load extension article"
                );

                return;
            }

            const article =
                await response.json();

            setUrl(
                article.url ?? ""
            );

            setProcessedUrl(
                article.url ?? ""
            );

            setReadabilityTitle(
                article.readabilityTitle ?? ""
            );

            setMetadataTitle(
                article.metadataTitle ?? ""
            );

            setArticleTitle(
                article.readabilityTitle ?? ""
            );

            setArticleBlocks(
                article.articleContent ?? []
            );

            setMissingBlocks(
                article.missingContent ?? []
            );

            setThumbnailUrl(
                article.thumbnailUrl ?? null
            );

            setPublishDate(
                article.publishDate ?? ""
            );

            setAuthors(
                article.authors?.join(", ") ?? ""
            );
        }

        loadArticle();
    }, []);

    function utcToLocalDatetimeInput(
        value: string | null | undefined
    ): string {
        if (!value) {
            return "";
        }

        const date = new Date(value);

        const pad = (n: number) =>
            String(n).padStart(2, "0");

        return (
            `${date.getFullYear()}-` +
            `${pad(date.getMonth() + 1)}-` +
            `${pad(date.getDate())}T` +
            `${pad(date.getHours())}:` +
            `${pad(date.getMinutes())}:` +
            `${pad(date.getSeconds())}`
        );
    }

    function localDatetimeInputToUtc(
        value: string
    ): string {
        if (!value) {
            return "";
        }

        return new Date(value).toISOString();
    }

    async function handleProcessWebpageSubmit(e: React.SubmitEvent<HTMLFormElement>) {
        setDisableSubmitButton(true);
        e.preventDefault();

        const form = e.currentTarget;
        const formData = new FormData(form);

        const submittedUrl = formData.get("url");

        if (submittedUrl?.toString().length === 0) {
            console.log("empty string");
            setDisableSubmitButton(false);
            return;
        }

        if (typeof submittedUrl !== "string") {
            console.log("not a string")
            setDisableSubmitButton(false);
            return;
        }

        setReadabilityTitle("");
        setMetadataTitle("");
        setSelectedTitleSource("readability");
        setArticleBlocks([]);
        setMissingBlocks([]);
        setSelectedBlocks([]);
        setUrl("");
        setIncludeHeader(true);

        const article = await processArticle(
            submittedUrl,
            setReadabilityTitle,
            setMetadataTitle,
            setArticleBlocks,
            setMissingBlocks,
            setThumbnailUrl,
            setPublishDate,
            setAuthors,
            setProcessedUrl
        );

        console.log(publishDate);

        setArticleTitle(article.readabilityTitle ?? "");
        setUrl(submittedUrl);
        setDisableSubmitButton(false);
    }

    async function handleSendToInstapaperSubmit(e: React.MouseEvent<HTMLButtonElement>) {
        setDisableSendToInstapaperButton(true);
        e.preventDefault();

        await sendArticleToInstapaper(url, title, displayedBlocks, includeHeader, thumbnailUrl);
        setDisableSendToInstapaperButton(false);
    }

    async function handleSendToWallabagSubmit(e: React.MouseEvent<HTMLButtonElement>) {
        setDisableSendToWallabagButton(true);
        e.preventDefault();

        await sendArticleToWallabag(url, articleTitle, displayedBlocks, includeHeader, thumbnailUrl, publishDate, authors);
        setDisableSendToWallabagButton(false);
    }

    function moveDisplayedBlockToMissing(
        block: ArticleBlock
    ) {
        setArticleBlocks((current) =>
            current.filter(
                currentBlock =>
                    currentBlock.id !== block.id
            )
        );

        setSelectedBlocks((current) =>
            current.filter(
                currentBlock =>
                    currentBlock.id !== block.id
            )
        );

        setMissingBlocks((current) => {
            const alreadyThere =
                current.some(
                    currentBlock =>
                        currentBlock.id === block.id
                );

            if (alreadyThere) {
                return current;
            }

            return [
                ...current,
                block,
            ].sort((a, b) => {
                const aIndex =
                    a.sourceIndex ??
                    Number.MAX_SAFE_INTEGER;

                const bIndex =
                    b.sourceIndex ??
                    Number.MAX_SAFE_INTEGER;

                return aIndex - bIndex;
            });
        });
    }

    function toggleMissingBlock(
        block: ArticleBlock,
        shiftKey: boolean
    ) {
        if (
            shiftKey &&
            lastSelectedSourceIndex !== null &&
            block.sourceIndex !== undefined
        ) {
            const start = Math.min(
                lastSelectedSourceIndex,
                block.sourceIndex
            );

            const end = Math.max(
                lastSelectedSourceIndex,
                block.sourceIndex
            );

            const range = likelyMissing.filter(
                candidate =>
                    candidate.sourceIndex !== undefined &&
                    candidate.sourceIndex >= start &&
                    candidate.sourceIndex <= end
            );

            setSelectedBlocks((current) => {
                const existing = new Set(
                    current.map(
                        block => block.sourceIndex
                    )
                );

                const newBlocks = range.filter(
                    block =>
                        !existing.has(
                            block.sourceIndex
                        )
                );

                return [
                    ...current,
                    ...newBlocks,
                ];
            });

            setLastSelectedSourceIndex(
                block.sourceIndex
            );

            return;
        }

        setSelectedBlocks((current) => {
            const isSelected = current.some(
                selected =>
                    selected.sourceIndex ===
                    block.sourceIndex
            );

            if (isSelected) {
                return current.filter(
                    selected =>
                        selected.sourceIndex !==
                        block.sourceIndex
                );
            }

            return [
                ...current,
                block,
            ];
        });

        if (block.sourceIndex !== undefined) {
            setLastSelectedSourceIndex(
                block.sourceIndex
            );
        }
    }

    function formatHtml(html: string): string {
        const container = document.createElement("div");
        container.innerHTML = html;

        const lines: string[] = [];

        function walk(node: Node, depth: number) {
            const indent = "  ".repeat(depth);

            if (node.nodeType === Node.TEXT_NODE) {
                const text = node.textContent?.trim();

                if (text) {
                    lines.push(indent + text);
                }

                return;
            }

            if (!(node instanceof HTMLElement)) {
                return;
            }

            const tag = node.tagName.toLowerCase();

            const attributes = Array.from(node.attributes)
                .map(attr => ` ${attr.name}="${attr.value}"`)
                .join("");

            const children = Array.from(node.childNodes);

            if (children.length === 0) {
                lines.push(
                    `${indent}<${tag}${attributes}></${tag}>`
                );

                return;
            }

            const onlyText =
                children.every(
                    child => child.nodeType === Node.TEXT_NODE
                );

            if (onlyText) {
                lines.push(
                    `${indent}<${tag}${attributes}>${node.textContent ?? ""}</${tag}>`
                );

                return;
            }

            lines.push(
                `${indent}<${tag}${attributes}>`
            );

            for (const child of children) {
                walk(child, depth + 1);
            }

            lines.push(
                `${indent}</${tag}>`
            );
        }

        for (const child of Array.from(container.childNodes)) {
            walk(child, 0);
        }

        return lines.join("\n");
    }

    function openBlockEditor(block: ArticleBlock) {
        setEditingBlock(block);

        setEditedHtml(
            formatHtml(block.html ?? "")
        );
    }

    function saveEditedBlock() {
        if (!editingBlock) {
            return;
        }

        const updatedBlock: ArticleBlock = {
            ...editingBlock,
            html: editedHtml,
        };

        setArticleBlocks(current =>
            current.map(block =>
                block.id === updatedBlock.id
                    ? updatedBlock
                    : block
            )
        );

        setSelectedBlocks(current =>
            current.map(block =>
                block.id === updatedBlock.id
                    ? updatedBlock
                    : block
            )
        );

        setMissingBlocks(current =>
            current.map(block =>
                block.id === updatedBlock.id
                    ? updatedBlock
                    : block
            )
        );

        setEditingBlock(null);
        setEditedHtml("");
    }

    return (
        <>
            <div className="titleBar">
                <h1 className="title">Alternative Article Extractor</h1>
                <div className="settingsButtons">
                    <button
                        className="destinationSelector"
                        onClick={() => {
                            setDestination(destination === "instapaper" ? "wallabag" : "instapaper");
                        }}>
                        {destination === "instapaper" ? "Instapaper" : "Wallabag"}
                    </button>
                    {processedUrl && (<button
                        type="button"
                        className="openArticleButton"
                        onClick={() => {
                            window.open(
                                processedUrl,
                                "_blank",
                                "noopener,noreferrer"
                            );
                        }}
                        disabled={!processedUrl}
                    >
                        Open ↗
                    </button>)}
                </div>
            </div>
            <form onSubmit={handleProcessWebpageSubmit} className="articleUrlSubmission">
                <input
                    className="articleUrlTextbox"
                    type="url"
                    name="url"
                    placeholder="Article URL"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    onClick={(e) => e.currentTarget.select()}
                />

                <button type="submit" disabled={disableSubmitButton} className="articleUrlSubmitButton">
                    Process Article
                </button>
            </form>
            <div className="mainContent">
                {displayedBlocks.length > 0 && (
                    <div className="displayedBlocks">
                        <div className="articlePreviewHeader">
                            {thumbnailUrl && (
                                <div className="thumbnailPreviewWrapper">
                                    <img
                                        className="thumbnailPreview"
                                        src={
                                            `${import.meta.env.VITE_EXTRACT_API}/api/image?url=` +
                                            encodeURIComponent(thumbnailUrl)
                                        }
                                        alt=""
                                        onClick={() =>
                                            setShowThumbnailModal(true)
                                        }
                                    />

                                    <button
                                        type="button"
                                        className="openThumbnailSource"
                                        title="Open original image"
                                        onClick={(e) => {
                                            e.stopPropagation();

                                            window.open(
                                                thumbnailUrl,
                                                "_blank",
                                                "noopener,noreferrer"
                                            );
                                        }}
                                    >
                                        ↗
                                    </button>
                                </div>
                            )}
                            {!thumbnailUrl && (
                                <button
                                    type="button"
                                    onClick={() => setShowThumbnailModal(true)}
                                >
                                    Choose thumbnail
                                </button>
                            )}
                            {showThumbnailModal && (
                                <div
                                    className="thumbnailModalOverlay"
                                    onClick={() => setShowThumbnailModal(false)}
                                >
                                    <div
                                        className="thumbnailModal"
                                        onClick={(e) => e.stopPropagation()}
                                    >
                                        <h2>Choose thumbnail</h2>

                                        <div className="customThumbnailInput">
                                            <input
                                                className="customThumbnailTextBox"
                                                type="url"
                                                placeholder="Image URL"
                                                value={customThumbnailUrl}
                                                onChange={(e) =>
                                                    setCustomThumbnailUrl(e.target.value)
                                                }
                                            />

                                            <button
                                                className="customThumbnailSubmit"
                                                type="button"
                                                onClick={() => {
                                                    if (!customThumbnailUrl.trim()) {
                                                        return;
                                                    }

                                                    setThumbnailUrl(
                                                        customThumbnailUrl.trim()
                                                    );

                                                    setShowThumbnailModal(false);
                                                    setCustomThumbnailUrl("");
                                                }}
                                            >
                                                Use URL
                                            </button>
                                        </div>

                                        <div className="thumbnailChoices">
                                            {availableImageUrls.map((src) => (
                                                <div
                                                    key={src}
                                                    className="thumbnailChoiceWrapper"
                                                >
                                                    <button
                                                        type="button"
                                                        className="thumbnailChoice"
                                                        onClick={() => {
                                                            setThumbnailUrl(src);
                                                            setShowThumbnailModal(false);
                                                        }}
                                                    >
                                                        <img
                                                            className="thumbnailChoiceImg"
                                                            src={
                                                                `${import.meta.env.VITE_EXTRACT_API}/api/image?url=` +
                                                                encodeURIComponent(src)
                                                            }
                                                            alt=""
                                                        />
                                                    </button>

                                                    <button
                                                        type="button"
                                                        className="openThumbnailChoiceSource"
                                                        title="Open original image"
                                                        onClick={(e) => {
                                                            e.stopPropagation();

                                                            window.open(
                                                                src,
                                                                "_blank",
                                                                "noopener,noreferrer"
                                                            );
                                                        }}
                                                    >
                                                        ↗
                                                    </button>
                                                </div>
                                            ))}
                                        </div>

                                        <button
                                            className="setThumbnailCancel"
                                            type="button"
                                            onClick={() =>
                                                setShowThumbnailModal(false)
                                            }
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                </div>
                            )}
                            {destination === "instapaper" &&
                                (<h1>{title}</h1>)}

                            {destination === "wallabag" &&
                                (
                                    <div className="articleInfo">
                                        <input className="articleTitleBox" type="text" value={articleTitle} onChange={(e) => setArticleTitle(e.target.value)} />
                                        <input
                                            className="publishDateBox"
                                            type="datetime-local"
                                            value={utcToLocalDatetimeInput(publishDate)}
                                            onChange={(e) => {
                                                setPublishDate(
                                                    localDatetimeInputToUtc(
                                                        e.target.value
                                                    )
                                                );
                                            }}
                                        />
                                        <input className="articleAuthorsBox" type="text" placeholder="Authors" value={authors} onChange={(e) => setAuthors(e.target.value)} />
                                    </div>
                                )}
                        </div>

                        <div className="articleBlocksList">
                            {previewBlocks.map((block) => {
                                if (destination === "wallabag" &&
                                    block.sourceIndex !== undefined) {
                                    return (
                                        <div
                                            key={block.id}
                                            className="removableDisplayedBlock"
                                            onClick={() =>
                                                moveDisplayedBlockToMissing(block)
                                            }
                                        >
                                            <ArticleBlockView block={block} />

                                            {block.type !== "image" && (
                                                <button
                                                    type="button"
                                                    className="editBlockButton"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        openBlockEditor(block);
                                                    }}
                                                >
                                                    ✎
                                                </button>
                                            )}
                                        </div>
                                    );
                                }

                                return (
                                    <ArticleBlockView
                                        key={block.id}
                                        block={block}
                                    />
                                );
                            })}
                        </div>
                    </div>
                )}
                {missingBlocks.length > 0 && (
                    <div className="missingBlocks">
                        <h1>Potential missing blocks</h1>

                        <div className="missingBlocksList">
                            {destination === "instapaper" && (likelyMissing.map((block) => (
                                <MissingBlockView
                                    key={block.id}
                                    block={block}
                                    selected={selectedBlocks.some(
                                        selected =>
                                            selected.sourceIndex === block.sourceIndex
                                    )}
                                    onToggle={(block, shiftKey) =>
                                        toggleMissingBlock(
                                            block,
                                            shiftKey
                                        )
                                    }
                                />
                            )))}
                            {destination === "wallabag" && (
                                likelyMissing
                                    .filter((block) => !selectedBlocks.includes(block))
                                    .map((block) => (
                                        <MissingBlockView
                                            key={block.id}
                                            block={block}
                                            selected={selectedBlocks.some(
                                                selected =>
                                                    selected.sourceIndex === block.sourceIndex
                                            )}
                                            onToggle={(block, shiftKey) =>
                                                toggleMissingBlock(
                                                    block,
                                                    shiftKey
                                                )
                                            }
                                        />
                                    ))
                            )}
                        </div>
                        {likelyJunk.length > 0 && (
                            <details className="junkContainer">
                                <summary className="junkDropdown">
                                    {likelyJunk.length} likely page-layout blocks hidden
                                </summary>

                                <div className="missingBlocksList">
                                    {likelyJunk.map((block) => (
                                        <MissingBlockView
                                            key={block.id}
                                            block={block}
                                            selected={selectedBlocks.some(
                                                selected =>
                                                    selected.sourceIndex === block.sourceIndex
                                            )}
                                            onToggle={(block, shiftKey) =>
                                                toggleMissingBlock(
                                                    block,
                                                    shiftKey
                                                )
                                            }
                                        />
                                    ))}
                                </div>
                            </details>
                        )}
                    </div>
                )}
            </div>
            {displayedBlocks.length > 0 && (
                <div className="footer">
                    {destination === "instapaper" && (<div className="selectTitleSource">
                        <select
                            value={selectedTitleSource}
                            className="selectTitleSourceDropdown"
                            onChange={(e) =>
                                setSelectedTitleSource(
                                    e.target.value as "readability" | "metadata"
                                )
                            }
                        >
                            <option value="readability">
                                {readabilityTitle}
                            </option>

                            <option value="metadata">
                                {metadataTitle}
                            </option>
                        </select>
                        <RiExpandUpDownFill className="selectTitleSourceIcon" />
                    </div>)}
                    <div className="includeHeader">
                        <button
                            className="includeHeaderButton"
                            onClick={() =>
                                setIncludeHeader(!includeHeader)
                            }>
                            {includeHeader ? "Remove header from HTML" : "Include header from HTML"}
                        </button>
                    </div>
                    {destination === "instapaper" && (<button type="submit" onClick={handleSendToInstapaperSubmit} disabled={disableSendToInstapaperButton} className="sendToInstapaperButton">
                        Send to Instapaper
                    </button>)}
                    {destination === "wallabag" && (<button type="submit" onClick={handleSendToWallabagSubmit} disabled={disableSendToWallabagButton} className="sendToInstapaperButton">
                        Send to Wallabag
                    </button>)}
                </div>
            )}
            {editingBlock && (
                <div
                    className="editBlockOverlay"
                    onClick={() => {
                        setEditingBlock(null);
                        setEditedHtml("");
                    }}
                >
                    <div
                        className="editBlockModal"
                        onClick={(e) =>
                            e.stopPropagation()
                        }
                    >
                        <h2>Edit raw HTML</h2>

                        <textarea
                            className="editBlockTextArea"
                            value={editedHtml}
                            autoFocus
                            onChange={(e) =>
                                setEditedHtml(
                                    e.target.value
                                )
                            }
                            onKeyDown={(e) => {
                                if (
                                    (e.metaKey || e.ctrlKey) &&
                                    e.key.toLowerCase() === "a"
                                ) {
                                    e.preventDefault();
                                    e.currentTarget.select();
                                }
                            }}
                        />

                        <div className="editBlockActions">
                            <button
                                className="cancelButton"
                                type="button"
                                onClick={() => {
                                    setEditingBlock(null);
                                    setEditedHtml("");
                                }}
                            >
                                Cancel
                            </button>

                            <button
                                className="saveButton"
                                type="button"
                                onClick={saveEditedBlock}
                            >
                                Save
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {disableSubmitButton && (
                <div className="loadingOverlay">
                    <div className="loadingBox">
                        <div className="spinner" />
                        <p>Processing article...</p>
                    </div>
                </div>
            )}
            {(disableSendToInstapaperButton || disableSendToWallabagButton) && (
                <div className="loadingOverlay">
                    <div className="loadingBox">
                        <div className="spinner" />
                        <p>Sending to {disableSendToInstapaperButton ? "Instapaper" : "Wallabag"}...</p>
                    </div>
                </div>
            )}
        </>
    )
}

export default App
