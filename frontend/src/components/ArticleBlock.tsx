import type { ArticleBlock } from "../../../shared/types";
import './ArticleBlock.css'

type Props = {
  block: ArticleBlock;
};

function ArticleBlockView({ block }: Props) {
  switch (block.type) {
    case "paragraph":
      return (
        <p className="paragraphBlock"
          dangerouslySetInnerHTML={{
            __html: block.html!,
          }}
        />
      );

    case "heading": {
      const Tag = `h${block.level}` as
        | "h1"
        | "h2"
        | "h3"
        | "h4"
        | "h5"
        | "h6";

      return (
        <Tag className="headerBlock"
          dangerouslySetInnerHTML={{
            __html: block.html!,
          }}
        />
      );
    }

    case "image": {
      const previewSrc =
        `${import.meta.env.VITE_EXTRACT_API}/api/image?url=` +
        encodeURIComponent(block.src!);

      return (
        <p className="imageBlock">
          <img
            src={previewSrc}
            alt={block.alt}
          />
        </p>
      );
    }

    case "ul":
      return (
        <ul className="unorderedListBlock"
          dangerouslySetInnerHTML={{
            __html: block.html!,
          }}
        />
      );

    case "ol":
      return (
        <ol className="orderedListBlock"
          dangerouslySetInnerHTML={{
            __html: block.html!,
          }}
        />
      );

    case "blockquote":
      return (
        <blockquote className="blockquoteBlock"
          dangerouslySetInnerHTML={{
            __html: block.html!,
          }}
        />
      );

    default:
      return null;
  }
}

export default ArticleBlockView;