import type { ArticleBlock } from "../../../shared/types";
import ArticleBlockView from "./ArticleBlock";
import "./ArticleBlock.css";

type MissingBlockProps = {
    block: ArticleBlock;
    selected: boolean;
    onToggle: (
        block: ArticleBlock,
        shiftKey: boolean
    ) => void;
};

function MissingBlockView({
    block,
    selected,
    onToggle,
}: MissingBlockProps) {
    return (
        <div
            className={`missingBlock ${selected ? "selected" : ""}`}
            onClick={(e) =>
                onToggle(
                    block,
                    e.shiftKey
                )
            }
        >
            <ArticleBlockView block={block} />
        </div>
    );
}

export default MissingBlockView;