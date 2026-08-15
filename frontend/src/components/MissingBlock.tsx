import type { ArticleBlock } from "../../../shared/types";
import ArticleBlockView from "./ArticleBlock";
import './ArticleBlock.css';

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
        <label className="missingBlock">
            <input className="checkbox"
                type="checkbox"
                checked={selected}
                onChange={(e) =>
                    onToggle(
                        block,
                        (e.nativeEvent as MouseEvent).shiftKey
                    )
                }
            />

            <ArticleBlockView block={block} />
        </label>
    );
}

export default MissingBlockView