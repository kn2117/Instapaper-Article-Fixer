export type MissingBlockCategory =
    | "content"
    | "other"

export type ArticleBlock = {
    type: string;
    sourceIndex?: number;
    readIndex?: number;
    src?: string;
    alt?: string;
    level?: number;
    html?: string;
    text?: string;
    category?: MissingBlockCategory;
    inHeaderOrFooter?: boolean;
    id?: string
};