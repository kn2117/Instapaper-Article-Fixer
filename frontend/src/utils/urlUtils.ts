import type { ArticleBlock } from "../../../shared/types";

export async function processArticle(url: string, setReadabilityTitle: React.Dispatch<React.SetStateAction<string>>, setMetadataTitle: React.Dispatch<React.SetStateAction<string>>, setArticleContent: React.Dispatch<React.SetStateAction<ArticleBlock[]>>, setMissingContent: React.Dispatch<React.SetStateAction<ArticleBlock[]>>, setThumbnailUrl: React.Dispatch<React.SetStateAction<string | null>>) {
    const urlData = {url: url};
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
}

export async function sendArticleToInstapaper(url: string, title: string, displayedBlocks: ArticleBlock[], includeHeader: boolean, thumbnailUrl: string | null) {
    const apiData = {
        url: url,
        title: title,
        finalContent: displayedBlocks,
        includeHeader: includeHeader,
        thumbnailUrl: thumbnailUrl
    }
    const response = await fetch(`${import.meta.env.VITE_EXTRACT_API}/api/send`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(apiData)
    });
    const responseBody = await response.json();
    console.log(responseBody.html);
}