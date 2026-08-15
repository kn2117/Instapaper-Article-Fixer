import type { ArticleBlock } from "../../../shared/types";

export async function processArticle(url: string, setTitle: React.Dispatch<React.SetStateAction<string>>, setArticleContent: React.Dispatch<React.SetStateAction<ArticleBlock[]>>, setMissingContent: React.Dispatch<React.SetStateAction<ArticleBlock[]>>) {
    const urlData = {url: url};
    const response = await fetch(`${import.meta.env.VITE_EXTRACT_API}/api/extract`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(urlData)
    });
    const responseBody = await response.json();
    setTitle(responseBody.title);
    setArticleContent(responseBody.articleContent);
    setMissingContent(responseBody.missingContent);
}

export async function sendArticleToInstapaper(url: string, title: string, displayedBlocks: ArticleBlock[]) {
    const apiData = {
        url: url,
        title: title,
        finalContent: displayedBlocks
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