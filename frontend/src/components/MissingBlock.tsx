import type { ArticleBlock } from "../../../shared/types";
import ArticleBlockView from "./ArticleBlock";

type MissingBlockProps = {
    block: ArticleBlock;
    selected: boolean;
    onToggle: (block: ArticleBlock) => void;
};

function MissingBlockView({
    block,
    selected,
    onToggle,
}: MissingBlockProps) {
    return (
        <div>
            <input
                type="checkbox"
                checked={selected}
                onChange={() => onToggle(block)}
            />

            <ArticleBlockView block={block} />
        </div>
    );
}

export default MissingBlockView