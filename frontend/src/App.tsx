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
    const [lastSelectedIndex, setLastSelectedIndex] = useState<number | null>(null);
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
    const [includeHeader, setIncludeHeader] = useState<boolean>(true);
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
    const previewBlocks: ArticleBlock[] = includeHeader
        ? [
            {
                type: "heading",
                level: 1,
                html: title,
                text: title,
            },
            ...displayedBlocks,
        ]
        : displayedBlocks;
    const firstHeadingIndex = previewBlocks.findIndex(
        block => block.type === "heading"
    );

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const incomingUrl = params.get("url");

        if (incomingUrl) {
            setUrl(incomingUrl);
        }
    }, []);

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

        await sendArticleToWallabag(url, title, displayedBlocks, includeHeader, thumbnailUrl, publishDate, authors);
        setDisableSendToWallabagButton(false);
    }

    function moveDisplayedBlockToMissing(block: ArticleBlock) {
        setArticleBlocks((current) =>
            current.filter(
                currentBlock =>
                    currentBlock.sourceIndex !== block.sourceIndex
            )
        );

        setSelectedBlocks((current) =>
            current.filter(
                currentBlock =>
                    currentBlock.sourceIndex !== block.sourceIndex
            )
        );

        setMissingBlocks((current) => {
            const alreadyThere = current.some(
                currentBlock =>
                    currentBlock.sourceIndex === block.sourceIndex
            );

            if (alreadyThere) {
                return current;
            }

            return [...current, block].sort((a, b) => {
                const aIndex =
                    a.sourceIndex ?? Number.MAX_SAFE_INTEGER;

                const bIndex =
                    b.sourceIndex ?? Number.MAX_SAFE_INTEGER;

                return aIndex - bIndex;
            });
        });
    }

    function toggleMissingBlock(
        block: ArticleBlock,
        index: number,
        shiftKey: boolean
    ) {
        if (shiftKey && lastSelectedIndex !== null) {
            const start = Math.min(lastSelectedIndex, index);
            const end = Math.max(lastSelectedIndex, index);

            const range = likelyMissing.slice(start, end + 1);

            setSelectedBlocks((current) => {
                const existing = new Set(
                    current.map(block => block.sourceIndex)
                );

                const newBlocks = range.filter(
                    block => !existing.has(block.sourceIndex)
                );

                return [...current, ...newBlocks];
            });

            setLastSelectedIndex(index);
            return;
        }

        setSelectedBlocks((current) => {
            const isSelected = current.some(
                selected =>
                    selected.sourceIndex === block.sourceIndex
            );

            if (isSelected) {
                return current.filter(
                    selected =>
                        selected.sourceIndex !== block.sourceIndex
                );
            }

            return [...current, block];
        });

        setLastSelectedIndex(index);
    }

    return (
        <>
            <h1>Alternative Article Extractor</h1>
            <button
                onClick={() => {
                    setDestination(destination === "instapaper" ? "wallabag" : "instapaper");
                }}>
                {destination === "instapaper" ? "Instapaper" : "Wallabag"}
            </button>
            <button
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
            </button>
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
                                <img
                                    className="thumbnailPreview"
                                    src={
                                        `${import.meta.env.VITE_EXTRACT_API}/api/image?url=` +
                                        encodeURIComponent(thumbnailUrl)
                                    }
                                    alt=""
                                    onClick={() => setShowThumbnailModal(true)}
                                />
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
                                                type="url"
                                                placeholder="Image URL"
                                                value={customThumbnailUrl}
                                                onChange={(e) =>
                                                    setCustomThumbnailUrl(e.target.value)
                                                }
                                            />

                                            <button
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
                                                <button
                                                    key={src}
                                                    type="button"
                                                    className="thumbnailChoice"
                                                    onClick={() => {
                                                        setThumbnailUrl(src);
                                                        setShowThumbnailModal(false);
                                                    }}
                                                >
                                                    <img
                                                        src={
                                                            `${import.meta.env.VITE_EXTRACT_API}/api/image?url=` +
                                                            encodeURIComponent(src)
                                                        }
                                                        alt=""
                                                    />
                                                </button>
                                            ))}
                                        </div>

                                        <button
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
                                        <input className="articlePublishDateBox" type="datetime-local" value={publishDate} onChange={(e) => setPublishDate(e.target.value)} />
                                        <input className="articleAuthorsBox" type="text" placeholder="Authors" value={authors} onChange={(e) => setAuthors(e.target.value)} />
                                    </div>
                                )}
                        </div>

                        <div className="articleBlocksList">
                            {previewBlocks.map((block, index) => {
                                if (index === firstHeadingIndex) {
                                    return null;
                                }

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
                            {destination === "instapaper" && (likelyMissing.map((block, index) => (
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
                                            index,
                                            shiftKey
                                        )
                                    }
                                />
                            )))}
                            {destination === "wallabag" && (
                                likelyMissing
                                    .filter((block) => !selectedBlocks.includes(block))
                                    .map((block, index) => (
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
                                                    index,
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
                                    {likelyJunk.map((block, index) => (
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
                                                    index,
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
