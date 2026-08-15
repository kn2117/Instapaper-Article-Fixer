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
    const [selectedBlocks, setSelectedBlocks] = useState<ArticleBlock[]>([]);
    const displayedBlocks = [
        ...articleBlocks,
        ...selectedBlocks,
    ].sort((a, b) => {
        const aIndex = a.sourceIndex ?? Number.MAX_SAFE_INTEGER;
        const bIndex = b.sourceIndex ?? Number.MAX_SAFE_INTEGER;

        return aIndex - bIndex;
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
            <form onSubmit={handleProcessWebpageSubmit}>
                <input
                    type="url"
                    name="url"
                    placeholder="Article URL"
                />

                <button type="submit" disabled={disableSubmitButton}>
                    Process Article
                </button>
            </form>
            {displayedBlocks.length > 0 && (
                <div>
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
                <div>
                    <h1>Potential missing blocks</h1>

                    {missingBlocks.map((block, index) => (
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
                </div>
            )}
            {displayedBlocks.length > 0 && (
                <button type="submit" onClick={handleSendToInstapaperSubmit} disabled={disableSendToInstapaperButton}>
                    Send to Instapaper
                </button>
            )}
        </>
    )
}

export default App
