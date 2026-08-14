import type { ArticleBlock } from "../../../shared/types";

type Props = {
  block: ArticleBlock;
};

function ArticleBlockView({ block }: Props) {
  switch (block.type) {
    case "paragraph":
      return (
        <p
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
            <Tag
            dangerouslySetInnerHTML={{
                __html: block.html!,
            }}
            />
        );
    }

    case "image":
      return (
        <p>
            <img
              src={block.src}
              alt={block.alt}
            />
        </p>
      );

    case "ul":
      return (
        <ul
          dangerouslySetInnerHTML={{
            __html: block.html!,
          }}
        />
      );

    case "ol":
      return (
        <ol
          dangerouslySetInnerHTML={{
            __html: block.html!,
          }}
        />
      );

    case "blockquote":
      return (
        <blockquote
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