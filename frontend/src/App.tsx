import { useEffect, useState } from 'react'
import './index.css'
import type { ArticleBlock } from "../../shared/types";
import { processArticle, sendArticleToInstapaper } from './utils/urlUtils';
import ArticleBlockView from './components/ArticleBlock';
import MissingBlockView from './components/MissingBlock';
import { RiExpandUpDownFill } from "react-icons/ri";

function App() {
    const [url, setUrl] = useState("");
    //const [title, setTitle] = useState("");
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
    const [includeHeader, setIncludeHeader] = useState<boolean>(true);
    const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
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

        await processArticle(submittedUrl, setReadabilityTitle, setMetadataTitle, setArticleBlocks, setMissingBlocks, setThumbnailUrl);
        setUrl(submittedUrl);
        setDisableSubmitButton(false);
    }

    async function handleSendToInstapaperSubmit(e: React.MouseEvent<HTMLButtonElement>) {
        setDisableSendToInstapaperButton(true);
        e.preventDefault();

        await sendArticleToInstapaper(url, title, displayedBlocks, includeHeader, thumbnailUrl);
        setDisableSendToInstapaperButton(false);
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
                                />
                            )}

                            <h1>{title}</h1>
                        </div>

                        {previewBlocks.map((block, index) => {
                            if (index === firstHeadingIndex) {
                                return null;
                            }

                            return (
                                <ArticleBlockView
                                    key={`${block.sourceIndex ?? "unmatched"}-${index}`}
                                    block={block}
                                />
                            );
                        })}
                    </div>
                )}
                {missingBlocks.length > 0 && (
                    <div className="missingBlocks">
                        <h1>Potential missing blocks</h1>

                        {likelyMissing.map((block, index) => (
                            <MissingBlockView
                                key={`${block.sourceIndex}-${index}`}
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
                        {likelyJunk.length > 0 && (
                            <details>
                                <summary className="junkDropdown">
                                    {likelyJunk.length} likely page-layout blocks hidden
                                </summary>

                                {likelyJunk.map((block, index) => (
                                    <MissingBlockView
                                        key={`junk-${block.sourceIndex}-${index}`}
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
                            </details>
                        )}
                    </div>
                )}
            </div>
            {displayedBlocks.length > 0 && (
                <div className="footer">
                    <div className="selectTitleSource">
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
                    </div>
                    <div className="includeHeader">
                        <button
                            className="includeHeaderButton"
                            onClick={() =>
                                setIncludeHeader(!includeHeader)
                            }>
                            {includeHeader ? "Remove header from HTML" : "Include header from HTML"}
                        </button>
                    </div>
                    <button type="submit" onClick={handleSendToInstapaperSubmit} disabled={disableSendToInstapaperButton} className="sendToInstapaperButton">
                        Send to Instapaper
                    </button>
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
            {disableSendToInstapaperButton && (
                <div className="loadingOverlay">
                    <div className="loadingBox">
                        <div className="spinner" />
                        <p>Sending to Instapaper...</p>
                    </div>
                </div>
            )}
        </>
    )
}

export default App
