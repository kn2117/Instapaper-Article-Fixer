import { useState } from 'react'
import './index.css'
import type { ArticleBlock } from "../../shared/types";
import { processArticle } from './utils/urlUtils';
import ArticleBlockView from './components/ArticleBlock';
import MissingBlockView from './components/MissingBlock';

function App() {
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

    async function handleSubmit(e: React.SubmitEvent<HTMLFormElement>) {
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

        await processArticle(submittedUrl, setTitle, setArticleBlocks, setMissingBlocks);
        setDisableSubmitButton(false);
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
            <form onSubmit={handleSubmit}>
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
        </>
    )
}

export default App
