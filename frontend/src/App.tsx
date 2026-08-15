import { useState } from 'react'
import './index.css'
import type { ArticleBlock } from "../../shared/types";
import { processArticle, sendArticleToInstapaper } from './utils/urlUtils';
import ArticleBlockView from './components/ArticleBlock';
import MissingBlockView from './components/MissingBlock';

function App() {
    const [url, setUrl] = useState("");
    const [title, setTitle] = useState("");
    const [articleBlocks, setArticleBlocks] = useState<ArticleBlock[]>([]);
    const [missingBlocks, setMissingBlocks] = useState<ArticleBlock[]>([]);
    const likelyMissing = missingBlocks.filter(
        block => block.category !== "other"
    );
    const likelyJunk = missingBlocks.filter(
        block => block.category === "other"
    );
    const [selectedBlocks, setSelectedBlocks] = useState<ArticleBlock[]>([]);
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

        setTitle("");
        setArticleBlocks([]);
        setMissingBlocks([]);
        setSelectedBlocks([]);
        setUrl("");

        await processArticle(submittedUrl, setTitle, setArticleBlocks, setMissingBlocks);
        setUrl(submittedUrl);
        setDisableSubmitButton(false);
    }

    async function handleSendToInstapaperSubmit(e: React.MouseEvent<HTMLButtonElement>) {
        setDisableSendToInstapaperButton(true);
        e.preventDefault();

        await sendArticleToInstapaper(url, title, displayedBlocks);
        setDisableSendToInstapaperButton(false);
    }

    function toggleMissingBlock(block: ArticleBlock) {
        setSelectedBlocks((current) => {
            const isSelected = current.some(
                (selected) =>
                    selected.sourceIndex === block.sourceIndex
            );

            if (isSelected) {
                // Already selected → remove it
                return current.filter(
                    (selected) =>
                        selected.sourceIndex !== block.sourceIndex
                );
            }

            // Not selected → add it
            return [...current, block];
        });
    }

    return (
        <>
            <h1>Alternative Article Extractor</h1>
            <form onSubmit={handleProcessWebpageSubmit} className="articleUrlSubmission">
                <input className="articleUrlTextbox"
                    type="url"
                    name="url"
                    placeholder="Article URL"
                    onClick={(e) => e.currentTarget.select()}
                />

                <button type="submit" disabled={disableSubmitButton} className="articleUrlSubmitButton">
                    Process Article
                </button>
            </form>
            <div className="mainContent">
                {displayedBlocks.length > 0 && (
                    <div className="displayedBlocks">
                        <h1>{title}</h1>

                        {displayedBlocks.map((block, index) => (
                            <ArticleBlockView
                                key={`${block.sourceIndex ?? "unmatched"}-${index}`}
                                block={block}
                            />
                        ))}
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
                                onToggle={toggleMissingBlock}
                            />
                        ))}
                        {likelyJunk.length > 0 && (
                            <details>
                                <summary>
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
                                        onToggle={toggleMissingBlock}
                                    />
                                ))}
                            </details>
                        )}
                    </div>
                )}
            </div>
            {displayedBlocks.length > 0 && (
                <button type="submit" onClick={handleSendToInstapaperSubmit} disabled={disableSendToInstapaperButton} className="sendToInstapaperButton">
                    Send to Instapaper
                </button>
            )}
        </>
    )
}

export default App
