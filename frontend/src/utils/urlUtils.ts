import type { ArticleBlock } from "../../../shared/types";

function normalizeDateTimeLocal(value: string | null | undefined) {
    if (!value) {
        return "";
    }

    // "2024-03-26T13:19:26-07:00"
    // becomes "2024-03-26T13:19"
    const match = value.match(
        /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/
    );

    if (match) {
        return `${match[1]}T${match[2]}`;
    }

    return "";
}

export async function processArticle(url: string, setReadabilityTitle: React.Dispatch<React.SetStateAction<string>>, setMetadataTitle: React.Dispatch<React.SetStateAction<string>>, setArticleContent: React.Dispatch<React.SetStateAction<ArticleBlock[]>>, setMissingContent: React.Dispatch<React.SetStateAction<ArticleBlock[]>>, setThumbnailUrl: React.Dispatch<React.SetStateAction<string | null>>, setPublishDate: React.Dispatch<React.SetStateAction<string>>, setAuthors: React.Dispatch<React.SetStateAction<string>>, setProcessedUrl: React.Dispatch<React.SetStateAction<string>>) {
    const urlData = { url: url };
    const response = await fetch(`${import.meta.env.VITE_EXTRACT_API}/api/extract`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(urlData)
    });
    const responseBody = await response.json();
    setReadabilityTitle(responseBody.readabilityTitle);
    setMetadataTitle(responseBody.metadataTitle);
    setArticleContent(responseBody.articleContent);
    setMissingContent(responseBody.missingContent);
    setThumbnailUrl(responseBody.thumbnailUrl ?? null);
    setPublishDate(
        normalizeDateTimeLocal(
            responseBody.publishDate
        )
    );

    setAuthors(
        responseBody.authors?.join(", ") ?? ""
    );
    setProcessedUrl(url);
    return responseBody;
}

export async function sendArticleToInstapaper(url: string, title: string, displayedBlocks: ArticleBlock[], includeHeader: boolean, thumbnailUrl: string | null) {
    const apiData = {
        url: url,
        title: title,
        finalContent: displayedBlocks,
        includeHeader: includeHeader,
        thumbnailUrl: thumbnailUrl
    }
    const response = await fetch(`${import.meta.env.VITE_EXTRACT_API}/api/sendinstapaper`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(apiData)
    });
    const responseBody = await response.json();
    console.log(responseBody.html);
}

export async function sendArticleToWallabag(url: string, title: string, displayedBlocks: ArticleBlock[], includeHeader: boolean, thumbnailUrl: string | null, publishDate: string, authors: string) {
    const apiData = {
        url: url,
        title: title,
        finalContent: displayedBlocks,
        includeHeader: includeHeader,
        thumbnailUrl: thumbnailUrl,
        publishDate: publishDate,
        authors: authors
    }
    const response = await fetch(`${import.meta.env.VITE_EXTRACT_API}/api/sendwallabag`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(apiData)
    });
    const responseBody = await response.json();
    console.log(responseBody.html);
}